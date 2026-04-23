"""
SOP Trainer AI — FastAPI Server
Wraps the pipeline.py functions as an HTTP API and persists results to Supabase.
"""

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from pipeline import (
    extract_audio,
    transcribe_audio,
    extract_keyframes,
    extract_step_frames,
    select_best_frame,
    synthesise_sop,
    get_video_duration,
    review_sop_steps,
    embed_texts,
    CLAUDE_MODEL,
)

# Haiku is used for query expansion — cheap + fast, runs on every chat request
HAIKU_MODEL = "claude-haiku-4-5-20251001"

# Optional supabase-py — install with: pip install supabase
try:
    from supabase import create_client, Client as SupabaseClient
    SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
    SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    supabase: SupabaseClient | None = (
        create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        if SUPABASE_URL and SUPABASE_SERVICE_KEY
        else None
    )
except ImportError:
    supabase = None

app = FastAPI(title="SOP Trainer AI", version="1.0")

_extra_origins = [o.strip() for o in os.environ.get("FRONTEND_URL", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"] + _extra_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# AI personality definitions
# ---------------------------------------------------------------------------

DEFAULT_PERSONALITY = "溫柔學姊"

PERSONALITY_PROMPTS: dict[str, str] = {
    "嚴厲學長": (
        "你的角色是「嚴厲學長」。說話直接、重視紀律，會提醒員工不要馬虎。"
        "語氣像軍訓教官，但帶有幽默感——可以在輕鬆時刻開個小玩笑。"
        "安全相關事項必須用最嚴肅、最清楚的語氣強調，絕不含糊。"
    ),
    "溫柔學姊": (
        "你的角色是「溫柔學姊」。有耐心、採用鼓勵式教學，會稱讚員工做得好。"
        "語氣像大姊姊在照顧新人，多用「喔」「呢」「哦」等語助詞，適時給予肯定與鼓勵。"
        "讓員工感受到被支持，而不是被評判。"
    ),
    "搞笑同事": (
        "你的角色是「搞笑同事」。輕鬆幽默、用梗和生活比喻解釋事情，讓學習變有趣。"
        "可以用誇張或好笑的方式說明，但遇到食品安全或危險操作，必須立刻切換成認真嚴肅的語氣，"
        "清楚說明風險，不能開玩笑。"
    ),
    "專業教練": (
        "你的角色是「專業教練」。正式但親切、條理分明，像企業培訓講師。"
        "使用清晰有條理的語言，適時以重點條列或步驟說明，讓員工一眼就能抓住重點。"
    ),
}


def _get_personality_prompt(personality: str) -> str:
    return PERSONALITY_PROMPTS.get(personality, PERSONALITY_PROMPTS[DEFAULT_PERSONALITY])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TriggerRequest(BaseModel):
    video_id: str
    storage_path: str


class EmployeeLoginRequest(BaseModel):
    pin: str
    owner_id: str


class ChatRequest(BaseModel):
    employee_id: str
    sop_id: str
    step_number: int
    question: str
    owner_id: str


class ProgressRequest(BaseModel):
    employee_id: str
    sop_id: str
    completed_step: int   # step_number that was just completed
    total_steps: int      # total steps in the SOP (to detect completion)


class BulkDeleteVideosRequest(BaseModel):
    video_ids: list[str]


class GeneralChatRequest(BaseModel):
    employee_id: str
    owner_id: str
    question: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _set_status(
    video_id: str,
    status: str,
    error_message: str | None = None,
    current_stage: str | None = None,
    progress_percent: int | None = None,
) -> None:
    """Set a terminal status (done / error) on a video record."""
    if supabase is None:
        return
    payload: dict = {"status": status}
    if error_message is not None:
        payload["error_message"] = error_message
    if current_stage is not None:
        payload["current_stage"] = current_stage
    if progress_percent is not None:
        payload["progress_percent"] = progress_percent
    supabase.table("videos").update(payload).eq("id", video_id).execute()


def _report_stage(video_id: str, stage: str, progress_percent: int) -> None:
    """Report the current pipeline stage and progress (0-100) to the DB."""
    if supabase is None:
        return
    supabase.table("videos").update({
        "status": "processing",
        "current_stage": stage,
        "progress_percent": progress_percent,
    }).eq("id", video_id).execute()


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _upload_keyframe_sync(
    supabase_client: "SupabaseClient", kf_path: Path, storage_path: str
) -> str:
    """Upload a keyframe PNG to Supabase Storage and return its public URL."""
    if not kf_path.exists():
        raise FileNotFoundError(f"Keyframe file missing on disk: {kf_path}")

    file_size = kf_path.stat().st_size
    print(f"[upload] {kf_path.name}  size={file_size}B  → training-videos/{storage_path}")

    data = kf_path.read_bytes()

    resp = supabase_client.storage.from_("training-videos").upload(
        path=storage_path,
        file=data,
        file_options={"content-type": "image/png", "upsert": "true"},
    )
    # supabase-py may return an error object instead of raising — check explicitly
    print(f"[upload] upload() response type={type(resp).__name__}  repr={resp!r}")

    url = supabase_client.storage.from_("training-videos").get_public_url(storage_path)
    print(f"[upload] public URL: {url}")
    return url


# ---------------------------------------------------------------------------
# Embedding helpers
# ---------------------------------------------------------------------------

def _embed_and_store_sop(sop_id: str, steps: list[dict]) -> None:
    """Embed all SOP step chunks and store in sop_embeddings (full refresh)."""
    if supabase is None:
        return

    chunks: list[str] = []
    valid_steps: list[dict] = []
    for step in steps:
        parts = [step.get("title", ""), step.get("description", "")]
        parts += step.get("warnings") or []
        chunk = " ".join(p for p in parts if p).strip()
        if chunk:
            chunks.append(chunk)
            valid_steps.append(step)

    if not chunks:
        return

    embeddings = embed_texts(chunks)

    # Full refresh for this SOP
    supabase.table("sop_embeddings").delete().eq("sop_id", sop_id).execute()

    records = [
        {
            "sop_id": sop_id,
            "step_number": step["step_number"],
            "chunk_text": chunk,
            "embedding": embedding,
            "metadata": {"title": step.get("title", "")},
        }
        for step, chunk, embedding in zip(valid_steps, chunks, embeddings)
    ]
    supabase.table("sop_embeddings").insert(records).execute()
    print(f"[embed] {len(records)} step embeddings stored for sop {sop_id}")


def _embed_and_store_faq(owner_id: str) -> None:
    """Re-embed this owner's FAQ entries and refresh their faq_embeddings."""
    if supabase is None:
        return

    faq_rows = (
        supabase.table("faq")
        .select("id, question, answer")
        .eq("owner_id", owner_id)
        .execute()
        .data or []
    )
    if not faq_rows:
        return

    chunks = [f"{r['question']} {r['answer']}" for r in faq_rows]
    embeddings = embed_texts(chunks)

    # Full refresh for this owner only
    supabase.table("faq_embeddings").delete().eq("owner_id", owner_id).execute()

    records = [
        {
            "faq_id": row["id"],
            "owner_id": owner_id,
            "chunk_text": chunk,
            "embedding": embedding,
            "metadata": {"question": row["question"]},
        }
        for row, chunk, embedding in zip(faq_rows, chunks, embeddings)
    ]
    if records:
        supabase.table("faq_embeddings").insert(records).execute()
    print(f"[embed] {len(records)} FAQ embeddings stored for owner {owner_id}")


# ---------------------------------------------------------------------------
# RAG helpers
# ---------------------------------------------------------------------------

CHAT_TOP_K = 5


def _expand_query(question: str) -> list[str]:
    """Rewrite the question into 2-3 phrasing variants using Claude Haiku.

    Returns [original_question, variant1, variant2, ...].
    Falls back to [original_question] on any error so RAG behavior is unchanged.

    Why: embedding models can latch onto modifier words (e.g. "大份") and push
    the true intent ("炸多久") below top_k. Multiple variants with different
    phrasings widen the recall net without changing top_k after dedup.
    """
    from anthropic import Anthropic
    client = Anthropic()

    prompt = (
        "你是一個搜尋查詢改寫助手。根據使用者的問題，產生 2-3 個保留核心意圖但用字不同的變體，"
        "用來搜尋公司 SOP 知識庫。\n\n"
        f"原始問題：{question}\n\n"
        "規則：\n"
        "- 保留問題的核心物件和動作（例如「炸雞」、「炸多久」）\n"
        "- 移除可能影響搜尋的修飾詞（例如份量、規格）\n"
        "- 使用同義詞擴展（例如「時間」、「幾分鐘」、「多久」）\n"
        "- 不要改變問題的基本意思\n\n"
        '以 JSON 陣列格式回答，只輸出陣列，不要有其他文字：\n["變體1", "變體2", "變體3"]'
    )

    try:
        response = client.messages.create(
            model=HAIKU_MODEL,
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        variants: list = json.loads(raw.strip())
        if isinstance(variants, list) and all(isinstance(v, str) for v in variants):
            result = [question] + [v for v in variants if v and v != question]
            print(f"[query-expansion] original: {question!r}")
            for i, v in enumerate(result[1:], 1):
                print(f"[query-expansion]   variant {i}: {v!r}")
            return result
    except Exception as exc:
        print(f"[query-expansion] ERROR (falling back to original only): {exc}")

    return [question]


def _dedup_sop_results(results: list[dict], top_k: int) -> list[dict]:
    """Deduplicate SOP embedding results by (sop_id, step_number), keep highest similarity."""
    best: dict[tuple, dict] = {}
    for r in results:
        key = (r.get("sop_id"), r.get("step_number"))
        if key not in best or r.get("similarity", 0) > best[key].get("similarity", 0):
            best[key] = r
    return sorted(best.values(), key=lambda x: x.get("similarity", 0), reverse=True)[:top_k]


def _dedup_faq_results(results: list[dict], top_k: int) -> list[dict]:
    """Deduplicate FAQ embedding results by faq_id, keep highest similarity."""
    best: dict[str, dict] = {}
    for r in results:
        key = str(r.get("faq_id") or r.get("chunk_text", ""))
        if key not in best or r.get("similarity", 0) > best[key].get("similarity", 0):
            best[key] = r
    return sorted(best.values(), key=lambda x: x.get("similarity", 0), reverse=True)[:top_k]


def _search_knowledge_base(
    query_embeddings: list[list[float]],
    sop_id: str,
    owner_id: str,
) -> tuple[list[dict], list[dict]]:
    """Search all knowledge layers for the most relevant content.

    Accepts multiple query embeddings (original + expanded variants) and unions
    results before deduplication so the top_k pool is drawn from all phrasings.

    Returns (sop_results, faq_results), each deduped and limited to CHAT_TOP_K.

    Layer 2a — current SOP: search_sop_embeddings, scoped to target_sop_id.
    Layer 2b — peer SOPs: search_owner_sop_embeddings, same owner, shareable_internal=true,
               excluding the current SOP so we don't double-count Layer 1 content.
    Layer 2c — FAQ: search_faq_embeddings, scoped to owner_id.
    Layer 3  — cross-owner (NOT ACTIVE): see stub below.
    """
    if supabase is None:
        return [], []

    raw_current_sop: list[dict] = []
    raw_peer_sop: list[dict] = []
    raw_faq: list[dict] = []

    for qvec in query_embeddings:
        # Layer 2a — current SOP
        try:
            resp = supabase.rpc("search_sop_embeddings", {
                "query_embedding": qvec,
                "target_sop_id": sop_id,
                "match_count": CHAT_TOP_K,
            }).execute()
            raw_current_sop.extend(resp.data or [])
        except Exception as exc:
            print(f"[rag] Layer 2a ERROR: {exc}")

        # Layer 2b — peer SOPs
        try:
            resp = supabase.rpc("search_owner_sop_embeddings", {
                "query_embedding": qvec,
                "target_owner_id": owner_id,
                "exclude_sop_id": sop_id,
                "match_count": CHAT_TOP_K,
            }).execute()
            raw_peer_sop.extend(resp.data or [])
        except Exception as exc:
            print(f"[rag] Layer 2b ERROR: {exc}")

        # Layer 2c — FAQ
        try:
            resp = supabase.rpc("search_faq_embeddings", {
                "query_embedding": qvec,
                "target_owner_id": owner_id,
                "match_count": CHAT_TOP_K,
            }).execute()
            raw_faq.extend(resp.data or [])
        except Exception as exc:
            print(f"[rag] Layer 2c ERROR: {exc}")

    # Dedup across variants, keep highest similarity per chunk
    current_sop_results = _dedup_sop_results(raw_current_sop, CHAT_TOP_K)
    peer_sop_results    = _dedup_sop_results(raw_peer_sop, CHAT_TOP_K)
    faq_results         = _dedup_faq_results(raw_faq, CHAT_TOP_K)

    n_variants = len(query_embeddings)
    n_raw = len(raw_current_sop) + len(raw_peer_sop) + len(raw_faq)
    n_deduped = len(current_sop_results) + len(peer_sop_results) + len(faq_results)
    print(f"[query-expansion] {n_variants} variant(s) → {n_raw} raw hits → {n_deduped} unique, top_k={CHAT_TOP_K}")

    print(f"[rag] Layer 2a (current SOP {sop_id}): {len(current_sop_results)} hits")
    for r in current_sop_results:
        print(f"  step {r.get('step_number')} | sim={r.get('similarity', 0):.3f} | {str(r.get('chunk_text', ''))[:60]!r}")

    print(f"[rag] Layer 2b (peer SOPs, owner {owner_id}, excluding {sop_id}): {len(peer_sop_results)} hits")
    if peer_sop_results:
        peer_sop_ids = list({r["sop_id"] for r in peer_sop_results})
        try:
            peer_sops = (
                supabase.table("sops")
                .select("id, title, shareable_internal")
                .in_("id", peer_sop_ids)
                .execute()
                .data or []
            )
            peer_sop_info = {s["id"]: s for s in peer_sops}
        except Exception:
            peer_sop_info = {}
        for r in peer_sop_results:
            info = peer_sop_info.get(r.get("sop_id", ""), {})
            print(
                f"  sop={info.get('title', r.get('sop_id'))} | "
                f"shareable_internal={info.get('shareable_internal')} | "
                f"step {r.get('step_number')} | sim={r.get('similarity', 0):.3f} | "
                f"{str(r.get('chunk_text', ''))[:60]!r}"
            )
    else:
        print("  (no peer SOP hits)")

    print(f"[rag] Layer 2c (FAQ, owner {owner_id}): {len(faq_results)} hits")

    sop_results = current_sop_results + peer_sop_results

    # TODO Layer 3 — cross-owner global knowledge pool (shareable_external=true).
    # Activate when Layer 3 is ready by uncommenting and merging into sop_results.
    # cross_results = supabase.rpc("search_global_sop_embeddings", {
    #     "query_embedding": query_embeddings[0],
    #     "match_count": CHAT_TOP_K,
    # }).execute().data or []
    # sop_results = sop_results + cross_results

    return sop_results, faq_results


def _fetch_layer1_context(
    sop_id: str, current_step_number: int
) -> tuple[list[dict], list[dict]]:
    """Fetch Layer 1 context in two parts:
    - all_step_outlines: step_number + title for every step in the SOP
    - nearby_steps: full content (title + description + warnings) for current ± 1
    """
    if supabase is None:
        return [], []

    all_step_outlines = (
        supabase.table("sop_steps")
        .select("step_number, title")
        .eq("sop_id", sop_id)
        .order("step_number")
        .execute()
        .data
    ) or []

    nearby_steps = (
        supabase.table("sop_steps")
        .select("step_number, title, description, warnings")
        .eq("sop_id", sop_id)
        .gte("step_number", max(1, current_step_number - 1))
        .lte("step_number", current_step_number + 1)
        .order("step_number")
        .execute()
        .data
    ) or []

    return all_step_outlines, nearby_steps


def _generate_chat_answer(
    question: str,
    current_step_number: int,
    all_step_outlines: list[dict],
    nearby_steps: list[dict],
    sop_results: list[dict],
    faq_results: list[dict],
    personality: str = DEFAULT_PERSONALITY,
) -> tuple[str, list[dict]]:
    """Build a RAG prompt and call Claude. Returns (answer, sources)."""
    from anthropic import Anthropic
    client = Anthropic()

    # Layer 1a — SOP outline: all steps as a numbered list (step_number + title only)
    outline_lines = [
        f"  {s['step_number']}. {s['title']}"
        + (" ← 目前步驟" if s["step_number"] == current_step_number else "")
        for s in all_step_outlines
    ]
    outline_text = "\n".join(outline_lines)

    # Layer 1b — full detail for current step + immediate neighbours
    detail_parts: list[str] = []
    for step in nearby_steps:
        tag = "【當前步驟】" if step["step_number"] == current_step_number else f"【步驟 {step['step_number']}】"
        warnings = step.get("warnings") or []
        warning_text = f"\n注意：{'; '.join(warnings)}" if warnings else ""
        detail_parts.append(
            f"{tag} 步驟 {step['step_number']}：{step['title']}\n"
            f"{step.get('description', '')}{warning_text}"
        )

    # Layer 2 — RAG results
    sources: list[dict] = []
    l2_parts: list[str] = []

    for r in sop_results:
        sn = r.get("step_number")
        title = (r.get("metadata") or {}).get("title", f"步驟 {sn}")
        l2_parts.append(f"【SOP 步驟 {sn} — {title}】\n{r['chunk_text']}")
        sources.append({"step_number": sn, "title": title, "type": "sop"})

    for r in faq_results:
        question_text = (r.get("metadata") or {}).get("question", "FAQ")
        l2_parts.append(f"【FAQ】{r['chunk_text']}")
        sources.append({"step_number": None, "title": question_text, "type": "faq"})

    user_content = (
        f"## SOP 流程概覽（共 {len(all_step_outlines)} 步）\n{outline_text}\n\n"
        "## 詳細內容（目前步驟前後）\n"
        + "\n\n".join(detail_parts)
        + ("\n\n## 相關知識庫\n" + "\n\n".join(l2_parts) if l2_parts else "")
        + f"\n\n## 員工問題\n{question}"
    )

    personality_instruction = _get_personality_prompt(personality)
    system_prompt = (
        f"{personality_instruction}\n\n"
        "你的職責是協助廚房員工理解訓練 SOP。\n"
        "請根據下方提供的 SOP 步驟與 FAQ 內容回答員工的問題。\n"
        "回答要簡潔實用，注重食品安全。\n"
        "使用與問題相同的語言（通常是繁體中文）回答。\n"
        "重要規則：\n"
        "- 只能根據提供的內容作答，不可自行補充或猜測。\n"
        "- 如果提供的內容中找不到答案，請用你的角色語氣回答：「這個問題我不太確定，建議詢問主管喔！」\n"
        "- 絕對不可編造 SOP 中未提及的資訊。"
    )

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=512,
        system=system_prompt,
        messages=[{"role": "user", "content": user_content}],
    )

    answer = response.content[0].text.strip()

    # Deduplicate sources by (step_number, title)
    seen: set[tuple] = set()
    unique_sources: list[dict] = []
    for s in sources:
        key = (s.get("step_number"), s.get("title"))
        if key not in seen:
            seen.add(key)
            unique_sources.append(s)

    return answer, unique_sources


def _search_knowledge_base_general(
    query_embeddings: list[list[float]],
    owner_id: str,
) -> tuple[list[dict], list[dict]]:
    """Search all shareable SOPs + FAQ for this owner.

    Accepts multiple query embeddings (original + expanded variants) and unions
    results before deduplication, same as _search_knowledge_base.

    Used by general chat (no current SOP context):
    - No Layer 2a (no current SOP)
    - Layer 2b: exclude_sop_id=None → all shareable SOPs searched
    - Layer 2c: FAQ search unchanged

    Each sop_result is enriched with a 'sop_title' key for source references.
    """
    if supabase is None:
        return [], []

    raw_sop: list[dict] = []
    raw_faq: list[dict] = []

    for qvec in query_embeddings:
        # Layer 2b — all shareable SOPs (no SOP to exclude)
        try:
            resp = supabase.rpc("search_owner_sop_embeddings", {
                "query_embedding": qvec,
                "target_owner_id": owner_id,
                "exclude_sop_id": None,
                "match_count": CHAT_TOP_K,
            }).execute()
            raw_sop.extend(resp.data or [])
        except Exception as exc:
            print(f"[rag:general] Layer 2 SOP ERROR: {exc}")

        # Layer 2c — FAQ
        try:
            resp = supabase.rpc("search_faq_embeddings", {
                "query_embedding": qvec,
                "target_owner_id": owner_id,
                "match_count": CHAT_TOP_K,
            }).execute()
            raw_faq.extend(resp.data or [])
        except Exception as exc:
            print(f"[rag:general] Layer 2 FAQ ERROR: {exc}")

    sop_results = _dedup_sop_results(raw_sop, CHAT_TOP_K)
    faq_results = _dedup_faq_results(raw_faq, CHAT_TOP_K)

    n_variants = len(query_embeddings)
    n_raw = len(raw_sop) + len(raw_faq)
    n_deduped = len(sop_results) + len(faq_results)
    print(f"[query-expansion] {n_variants} variant(s) → {n_raw} raw hits → {n_deduped} unique, top_k={CHAT_TOP_K}")

    # Enrich results with SOP-level titles (for source references)
    print(f"[rag:general] Layer 2 SOPs (owner {owner_id}): {len(sop_results)} hits")
    if sop_results:
        unique_sop_ids = list({r.get("sop_id") for r in sop_results if r.get("sop_id")})
        try:
            sop_rows = (
                supabase.table("sops")
                .select("id, title")
                .in_("id", unique_sop_ids)
                .execute()
                .data or []
            )
            sop_title_map = {r["id"]: r["title"] for r in sop_rows}
        except Exception:
            sop_title_map = {}
        for r in sop_results:
            r["sop_title"] = sop_title_map.get(r.get("sop_id", ""), "")
            print(f"  sop={r.get('sop_title')} | step {r.get('step_number')} | "
                  f"sim={r.get('similarity', 0):.3f} | {str(r.get('chunk_text', ''))[:60]!r}")

    print(f"[rag:general] Layer 2 FAQ (owner {owner_id}): {len(faq_results)} hits")

    return sop_results, faq_results


def _generate_general_chat_answer(
    question: str,
    sop_title_outline: list[dict],     # [{"id": str, "title": str}] — all published SOPs
    sop_results: list[dict],           # enriched with "sop_title" key
    faq_results: list[dict],
    personality: str = DEFAULT_PERSONALITY,
) -> tuple[str, list[dict]]:
    """Build a RAG prompt for general Q&A (no specific SOP context) and call Claude.

    Layer 1: all published SOP titles as an outline.
    Layer 2: sop_results (grouped at SOP level for source references) + faq_results.
    Sources use sop_id so the frontend can link to /train/[sop_id].
    """
    from anthropic import Anthropic
    client = Anthropic()

    # Layer 1 — all published SOP titles as orientation outline
    outline_lines = [f"  - {s['title']}" for s in sop_title_outline]
    outline_text = "\n".join(outline_lines) or "  （尚無已發布的 SOP）"

    # Layer 2 — RAG results; deduplicate SOP sources at SOP level
    sources: list[dict] = []
    l2_parts: list[str] = []
    seen_sop_ids: set[str] = set()

    for r in sop_results:
        sn = r.get("step_number")
        step_title = (r.get("metadata") or {}).get("title", f"步驟 {sn}")
        sop_id = r.get("sop_id", "")
        sop_title = r.get("sop_title", "")
        l2_parts.append(f"【{sop_title} — 步驟 {sn} — {step_title}】\n{r.get('chunk_text', '')}")
        if sop_id and sop_id not in seen_sop_ids:
            seen_sop_ids.add(sop_id)
            sources.append({"sop_id": sop_id, "title": sop_title, "type": "sop", "step_number": None})

    for r in faq_results:
        question_text = (r.get("metadata") or {}).get("question", "FAQ")
        l2_parts.append(f"【FAQ】{r.get('chunk_text', '')}")
        sources.append({"sop_id": None, "title": question_text, "type": "faq", "step_number": None})

    user_content = (
        f"## 本店 SOP 列表\n{outline_text}\n\n"
        + ("## 相關知識庫\n" + "\n\n".join(l2_parts) if l2_parts else "## 相關知識庫\n（無相關內容）")
        + f"\n\n## 員工問題\n{question}"
    )

    personality_instruction = _get_personality_prompt(personality)
    system_prompt = (
        f"{personality_instruction}\n\n"
        "員工沒有在特定 SOP 內，他們可能遇到任何工作相關問題。根據提供的 SOP 知識庫回答。\n"
        "如果問題內容不在提供的 context 中，請說「這個問題我不確定，建議詢問您的主管」\n"
        "回答要簡潔實用。使用與問題相同的語言（通常是繁體中文）回答。\n"
        "重要規則：\n"
        "- 只能根據提供的內容作答，不可自行補充或猜測。\n"
        "- 絕對不可編造 SOP 中未提及的資訊。"
    )

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=512,
        system=system_prompt,
        messages=[{"role": "user", "content": user_content}],
    )

    answer = response.content[0].text.strip()
    return answer, sources


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------

async def run_pipeline(video_id: str, storage_path: str) -> None:
    """Download video from Supabase Storage, run pipeline, save SOP to DB.

    Stages (SOP-driven path):
      0. 音訊提取   — ffmpeg audio extraction
      1. 語音辨識   — Whisper transcription
      2. SOP 生成   — Claude generates SOP from transcript
      3. 截圖擷取   — 3 candidate frames extracted per step
      4. AI 選圖    — Claude Vision picks best frame per step
      5. 上傳截圖   — selected frames uploaded to Supabase Storage
      6. 審核掃描   — Claude review flags per step

    Fallback (no timestamps): stages 3-5 collapse into a single blind
    scene-detection + even-distribution pass before stage 6.
    """
    if supabase is None:
        print(f"[pipeline] Supabase not configured, skipping {video_id}")
        return

    STAGES = ["音訊提取", "語音辨識", "SOP 生成", "截圖擷取", "AI 選圖", "上傳截圖", "審核掃描", "知識建構"]

    def advance(idx: int) -> None:
        pct = round(idx / len(STAGES) * 100)
        label = STAGES[idx]
        print(f"[pipeline] [{pct}%] {label}")
        _report_stage(video_id, label, pct)

    work_dir = Path(tempfile.mkdtemp(prefix="sop_pipeline_"))
    sop_id: str | None = None
    try:
        # ── Resolve owner ────────────────────────────────────────────────────
        video_row = (
            supabase.table("videos")
            .select("owner_id")
            .eq("id", video_id)
            .single()
            .execute()
            .data
        )
        owner_id: str | None = (video_row or {}).get("owner_id")
        print(f"[pipeline] owner_id={owner_id!r}")

        # ── Download ────────────────────────────────────────────────────────
        print(f"[pipeline] Downloading {storage_path}")
        res = supabase.storage.from_("training-videos").download(storage_path)
        video_file = work_dir / Path(storage_path).name
        video_file.write_bytes(res)

        # ── Stage 0: 音訊提取 ───────────────────────────────────────────────
        advance(0)
        audio_path = await asyncio.to_thread(extract_audio, video_file, work_dir)

        # ── Stage 1: 語音辨識 ───────────────────────────────────────────────
        advance(1)
        transcript_segments = await asyncio.to_thread(transcribe_audio, audio_path)

        # ── Stage 2: SOP 生成 ───────────────────────────────────────────────
        advance(2)
        duration = await asyncio.to_thread(get_video_duration, video_file)
        sop = await asyncio.to_thread(synthesise_sop, transcript_segments, [], duration)

        # Persist SOP record now so we have sop_id for storage paths
        sop_title = sop.get("title", "Untitled SOP")
        video_url = supabase.storage.from_("training-videos").get_public_url(storage_path)
        sop_res = (
            supabase.table("sops")
            .insert({"video_id": video_id, "title": sop_title, "raw_json": sop, "video_url": video_url, "owner_id": owner_id})
            .execute()
        )
        sop_id = sop_res.data[0]["id"]

        steps = sop.get("steps", [])
        image_urls: list[str | None] = [None] * len(steps)

        if steps:
            # Log first step's full structure so we can verify Claude's key names
            print(f"[pipeline] raw step[0] keys: {list(steps[0].keys())}")
            print(f"[pipeline] raw step[0] timestamps: "
                  f"start={steps[0].get('timestamp_start')!r}  "
                  f"end={steps[0].get('timestamp_end')!r}")
            has_timestamps = any(s.get("timestamp_start") is not None for s in steps)
            print(f"[pipeline] {len(steps)} steps, has_timestamps={has_timestamps}")

            if has_timestamps:
                # ── Stage 3: 截圖擷取 — extract 3 candidates per step ───────
                advance(3)
                all_frame_paths: list[list[Path]] = []
                for i, step in enumerate(steps):
                    paths = await asyncio.to_thread(
                        extract_step_frames, video_file, step, work_dir, i
                    )
                    print(f"[pipeline]   step {i + 1}: {len(paths)} candidates")
                    all_frame_paths.append(paths)

                # ── Stage 4: AI 選圖 — Claude Vision picks best frame ────────
                advance(4)
                selected_frames: list[Path | None] = []
                for i, (step, paths) in enumerate(zip(steps, all_frame_paths)):
                    chosen = await asyncio.to_thread(select_best_frame, step, paths)
                    print(f"[pipeline]   step {i + 1}: selected={chosen}")
                    selected_frames.append(chosen)

                # ── Stage 5: 上傳截圖 — upload selected frames ───────────────
                advance(5)
                for i, chosen in enumerate(selected_frames):
                    if chosen is None:
                        continue
                    kf_storage = f"sops/{sop_id}/frames/step_{i + 1}.png"
                    try:
                        url = await asyncio.to_thread(
                            _upload_keyframe_sync, supabase, chosen, kf_storage
                        )
                        image_urls[i] = url
                        print(f"[pipeline]   step {i + 1}: ✓ {url}")
                    except Exception:
                        print(f"[pipeline]   step {i + 1}: ✗ upload failed:")
                        traceback.print_exc()

            else:
                # ── Fallback: blind scene-detection → even distribution ───────
                print("[pipeline] No timestamps — falling back to scene-detection sampling")
                advance(3)
                keyframes = await asyncio.to_thread(extract_keyframes, video_file, work_dir)
                print(f"[pipeline] Fallback: {len(keyframes)} keyframes extracted")

                advance(5)  # skip AI 選圖; go straight to upload
                for i in range(len(steps)):
                    if not keyframes:
                        break
                    kf = keyframes[int(i * len(keyframes) / len(steps))]
                    kf_storage = f"sops/{sop_id}/frames/step_{i + 1}.png"
                    try:
                        url = await asyncio.to_thread(
                            _upload_keyframe_sync, supabase, Path(kf["path"]), kf_storage
                        )
                        image_urls[i] = url
                        print(f"[pipeline]   step {i + 1}: ✓ fallback {url}")
                    except Exception:
                        print(f"[pipeline]   step {i + 1}: ✗ fallback upload failed:")
                        traceback.print_exc()

            # Insert steps with resolved image URLs and timestamps
            step_rows = [
                {
                    "sop_id": sop_id,
                    "step_number": i + 1,
                    "title": step.get("title", ""),
                    "description": step.get("description", ""),
                    "warnings": step.get("warnings", []),
                    "image_url": image_urls[i],
                    # ⚠️ CRITICAL: timestamp_start is required for the video playback feature
                    # (SOP reader "觀看示範" button seeks to this timestamp). Do not remove.
                    # Regression history: fixed 2026-04-16, regressed in Phase 4 refactor, fixed again 2026-04-20.
                    "timestamp_start": step.get("timestamp_start"),
                }
                for i, step in enumerate(steps)
            ]
            # Defensive check: warn if timestamps are unexpectedly missing
            missing_ts = [r["step_number"] for r in step_rows if r.get("timestamp_start") is None]
            if missing_ts and any(s.get("timestamp_start") is not None for s in sop["steps"]):
                print(f"[WARNING] timestamp_start lost during step_rows construction for steps: {missing_ts}")
            for row in step_rows:
                print(f"[db-insert] step {row['step_number']}: timestamp_start={row.get('timestamp_start')!r}")
            insert_resp = supabase.table("sop_steps").insert(step_rows).execute()
            print(f"[db-insert] insert response: {insert_resp.data[:1] if insert_resp.data else insert_resp}")

            # ── Stage 6: 審核掃描 ────────────────────────────────────────────
            advance(6)
            inserted = (
                supabase.table("sop_steps")
                .select("*")
                .eq("sop_id", sop_id)
                .order("step_number")
                .execute()
                .data
            )
            await _apply_review(sop_id, inserted)

            # ── Stage 7: 知識建構 — embed steps + FAQ for RAG ────────────────
            advance(7)
            await asyncio.to_thread(_embed_and_store_sop, sop_id, inserted)
            if owner_id:
                await asyncio.to_thread(_embed_and_store_faq, owner_id)

        _set_status(video_id, "done", current_stage="完成", progress_percent=100)
        print(f"[pipeline] Done — video {video_id}, sop {sop_id}")

    except Exception as exc:
        error_msg = str(exc)[:500]
        print(f"[pipeline] ERROR for {video_id}: {error_msg}")
        _set_status(video_id, "error", error_message=error_msg)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


async def _apply_review(sop_id: str, steps: list[dict]) -> None:
    """Run Claude review on `steps` and persist flags. Resets review_confirmed.

    This function does a PARTIAL UPDATE (review_flags + review_confirmed only).
    It does NOT touch timestamp_start or any other column.
    """
    if not steps or supabase is None:
        return
    # Log timestamp_start values before update so we can verify they're untouched
    print(f"[review] Starting review for sop {sop_id} ({len(steps)} steps)")
    for step in steps:
        print(f"[review] pre-update step {step.get('step_number')}: "
              f"timestamp_start={step.get('timestamp_start')!r}")

    flags_list = await asyncio.to_thread(review_sop_steps, steps)
    for step, flags in zip(steps, flags_list):
        supabase.table("sop_steps").update(
            # ⚠️ CRITICAL: only review_flags and review_confirmed are updated here.
            # timestamp_start and all other columns are intentionally omitted —
            # Supabase PATCH leaves unspecified columns unchanged.
            {"review_flags": flags, "review_confirmed": False}
        ).eq("id", step["id"]).execute()

    # Read back to verify timestamp_start was not touched
    readback = (
        supabase.table("sop_steps")
        .select("step_number, timestamp_start")
        .eq("sop_id", sop_id)
        .order("step_number")
        .execute()
        .data
    ) or []
    for row in readback:
        print(f"[review] post-update step {row.get('step_number')}: "
              f"timestamp_start={row.get('timestamp_start')!r}")
    missing = [r["step_number"] for r in readback if r.get("timestamp_start") is None]
    if missing:
        print(f"[review] ⚠️ WARNING: timestamp_start is NULL after review update for steps: {missing}")
    print(f"[review] Flags written for sop {sop_id} ({len(steps)} steps)")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.post("/pipeline/trigger")
async def trigger_pipeline(req: TriggerRequest, background_tasks: BackgroundTasks):
    """Enqueue a pipeline run for the given video."""
    background_tasks.add_task(run_pipeline, req.video_id, req.storage_path)
    return {"status": "queued", "video_id": req.video_id}


@app.post("/sops/{sop_id}/review")
async def review_sop(sop_id: str):
    """Re-run the review pass on all steps of an existing SOP (synchronous)."""
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    steps = (
        supabase.table("sop_steps")
        .select("*")
        .eq("sop_id", sop_id)
        .order("step_number")
        .execute()
        .data
    )
    if not steps:
        return {"status": "ok", "reviewed": 0}

    await _apply_review(sop_id, steps)
    return {"status": "ok", "reviewed": len(steps)}


@app.post("/api/videos/bulk-delete")
async def bulk_delete_videos(req: BulkDeleteVideosRequest):
    """Delete video records and their files from Storage.

    SOPs generated from these videos are NOT deleted — sops.video_id is set to
    NULL via the ON DELETE SET NULL foreign-key constraint.
    Storage errors (e.g. file already missing) are logged but not fatal.
    """
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")
    if not req.video_ids:
        return {"deleted": 0}

    # 1. Fetch storage_paths so we can clean up Storage
    rows = (
        supabase.table("videos")
        .select("id, storage_path")
        .in_("id", req.video_ids)
        .execute()
        .data or []
    )

    storage_paths = [r["storage_path"] for r in rows if r.get("storage_path")]

    # 2. Remove files from Storage (non-fatal if some are already gone)
    if storage_paths:
        try:
            supabase.storage.from_("training-videos").remove(storage_paths)
            print(f"[bulk-delete] removed {len(storage_paths)} storage file(s)")
        except Exception as exc:
            print(f"[bulk-delete] storage removal warning: {exc}")

    # 3. Delete video records — ON DELETE SET NULL handles sops.video_id
    result = (
        supabase.table("videos")
        .delete()
        .in_("id", req.video_ids)
        .execute()
    )
    deleted = len(result.data) if result.data else len(req.video_ids)
    print(f"[bulk-delete] deleted {deleted} video record(s)")
    return {"deleted": deleted}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """RAG-powered Q&A for employee training.

    Always runs both retrieval layers then lets Claude decide relevance:
      1. Embed question (OpenAI).
      2. Layer 1: fetch current + adjacent steps from DB.
      3. Layer 2: search sop_embeddings + faq_embeddings (top-3 each).
      4. Call Claude with all context; Claude handles irrelevant questions.
      5. Persist to chat_history.
    """
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Empty question")

    # Step 1 — look up personality setting for this owner (non-fatal, falls back to default)
    try:
        settings_rows = (
            supabase.table("store_settings")
            .select("ai_personality")
            .eq("owner_id", req.owner_id)
            .limit(1)
            .execute()
            .data
        )
        personality = settings_rows[0]["ai_personality"] if settings_rows else DEFAULT_PERSONALITY
    except Exception:
        personality = DEFAULT_PERSONALITY

    # Step 2 — expand query into variants + embed all of them
    variants = await asyncio.to_thread(_expand_query, question)
    all_embeddings = await asyncio.to_thread(embed_texts, variants)

    # Step 3 — Layer 2: search knowledge base with all variants, dedup, top_k
    sop_results, faq_results = await asyncio.to_thread(
        _search_knowledge_base, all_embeddings, req.sop_id, req.owner_id
    )

    # Step 4 — Layer 1: all step titles (outline) + full detail for current ± 1
    all_step_outlines, nearby_steps = await asyncio.to_thread(
        _fetch_layer1_context, req.sop_id, req.step_number
    )

    # Step 5 — call Claude with all context + personality
    answer, sources = await asyncio.to_thread(
        _generate_chat_answer,
        question,
        req.step_number,
        all_step_outlines,
        nearby_steps,
        sop_results,
        faq_results,
        personality,
    )

    # Step 6 — persist to chat_history (non-fatal)
    try:
        supabase.table("chat_history").insert({
            "employee_id": req.employee_id,
            "sop_id": req.sop_id,
            "step_number": req.step_number,
            "question": question,
            "answer": answer,
            "sources": sources,
        }).execute()
    except Exception:
        pass

    return {"answer": answer, "sources": sources}


@app.post("/api/chat/general")
async def general_chat(req: GeneralChatRequest):
    """General Q&A for employees outside any specific SOP context.

    Used by the "老闆我有問題！" button on the /train module selection page.
    No sop_id / step_number — knowledge comes from all of the owner's
    shareable SOPs and FAQ.

    Layer 1: all published SOP titles as an outline.
    Layer 2: search_owner_sop_embeddings (all shareable, no exclusion) + FAQ.
    Sources are at SOP level with sop_id for frontend linking.
    """
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Empty question")

    # Step 1 — personality setting
    try:
        settings_rows = (
            supabase.table("store_settings")
            .select("ai_personality")
            .eq("owner_id", req.owner_id)
            .limit(1)
            .execute()
            .data
        )
        personality = settings_rows[0]["ai_personality"] if settings_rows else DEFAULT_PERSONALITY
    except Exception:
        personality = DEFAULT_PERSONALITY

    # Step 2 — all published SOP titles for this owner (Layer 1 outline)
    try:
        sop_title_outline = (
            supabase.table("sops")
            .select("id, title")
            .eq("owner_id", req.owner_id)
            .eq("published", True)
            .order("title")
            .execute()
            .data or []
        )
    except Exception:
        sop_title_outline = []

    # Step 3 — expand query into variants + embed all of them
    variants = await asyncio.to_thread(_expand_query, question)
    all_embeddings = await asyncio.to_thread(embed_texts, variants)

    # Step 4 — search all shareable SOPs + FAQ with all variants, dedup, top_k
    sop_results, faq_results = await asyncio.to_thread(
        _search_knowledge_base_general, all_embeddings, req.owner_id
    )

    # Step 5 — generate answer
    answer, sources = await asyncio.to_thread(
        _generate_general_chat_answer,
        question,
        sop_title_outline,
        sop_results,
        faq_results,
        personality,
    )

    # Step 6 — persist to chat_history (sop_id and step_number are null for general chat)
    try:
        supabase.table("chat_history").insert({
            "employee_id": req.employee_id,
            "sop_id": None,
            "step_number": None,
            "question": question,
            "answer": answer,
            "sources": sources,
        }).execute()
    except Exception:
        pass

    return {"answer": answer, "sources": sources}


@app.post("/auth/employee")
async def employee_login(req: EmployeeLoginRequest):
    """Verify employee PIN and return employee info."""
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    pin = req.pin.strip()
    if not pin.isdigit() or not (4 <= len(pin) <= 6):
        raise HTTPException(status_code=400, detail="PIN must be 4–6 digits")

    owner_id = req.owner_id.strip()
    if not owner_id:
        raise HTTPException(status_code=400, detail="owner_id is required")

    pin_hash = _sha256(pin)
    res = (
        supabase.table("employees")
        .select("id, name, owner_id")
        .eq("pin_hash", pin_hash)
        .eq("owner_id", owner_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=401, detail="Invalid PIN")

    employee = res.data[0]
    return {"id": employee["id"], "name": employee["name"], "owner_id": employee["owner_id"]}


# ---------------------------------------------------------------------------
# Progress routes — called from the employee-facing train UI
# ---------------------------------------------------------------------------

@app.post("/api/progress")
async def upsert_progress(req: ProgressRequest):
    """Record that an employee completed a step (or the whole SOP).

    Idempotent: re-completing an already-completed step is a no-op for that
    step but still updates current_step so resume works correctly.
    """
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    rows = (
        supabase.table("training_progress")
        .select("id, completed_steps, completed_at")
        .eq("employee_id", req.employee_id)
        .eq("sop_id", req.sop_id)
        .execute()
        .data
    )
    existing = rows[0] if rows else None

    # Never overwrite a completed record's completed_at
    already_done = existing and existing.get("completed_at") is not None

    prev_steps: list[int] = (existing or {}).get("completed_steps") or []
    merged = sorted(set(prev_steps + [req.completed_step]))

    is_complete = req.completed_step >= req.total_steps
    next_step = req.completed_step + 1  # step to resume at on next visit

    payload: dict = {
        "employee_id": req.employee_id,
        "sop_id": req.sop_id,
        "current_step": next_step,
        "completed_steps": merged,
    }
    if is_complete and not already_done:
        payload["completed_at"] = datetime.now(timezone.utc).isoformat()

    if existing:
        supabase.table("training_progress").update(payload).eq("id", existing["id"]).execute()
    else:
        supabase.table("training_progress").insert(payload).execute()

    return {"status": "completed" if is_complete else "in_progress"}


@app.get("/api/progress/{employee_id}/{sop_id}")
async def get_sop_progress(employee_id: str, sop_id: str):
    """Return the progress record for one employee + SOP, or null."""
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    rows = (
        supabase.table("training_progress")
        .select("*")
        .eq("employee_id", employee_id)
        .eq("sop_id", sop_id)
        .execute()
        .data
    )
    return rows[0] if rows else None


@app.get("/api/progress/{employee_id}")
async def get_employee_progress(employee_id: str):
    """Return all progress records for an employee (used by module selection page)."""
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    rows = (
        supabase.table("training_progress")
        .select("sop_id, current_step, completed_steps, completed_at")
        .eq("employee_id", employee_id)
        .execute()
        .data
    )
    return rows
