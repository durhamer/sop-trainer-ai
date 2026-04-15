export type EmployeeSession = { id: string; name: string }

const SESSION_KEY = "employee_session"

export function getEmployeeSession(): EmployeeSession | null {
  if (typeof window === "undefined") return null
  const raw = sessionStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as EmployeeSession
  } catch {
    return null
  }
}

export function setEmployeeSession(session: EmployeeSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearEmployeeSession(): void {
  sessionStorage.removeItem(SESSION_KEY)
}

/** SHA-256 the PIN string using Web Crypto (browser only). */
export async function hashPin(pin: string): Promise<string> {
  const buffer = new TextEncoder().encode(pin)
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
