// A part of a page that starts folded, for what only some visits need (v3 MO-6): its head is one button with
// aria-expanded that controls the body, and the body leaves the page while folded. With a key, this browser keeps the
// owner's choice (`adiutor.fold.<key>` in localStorage); without storage the part simply starts folded again.

import { ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"

const PREFIX = "adiutor.fold."

function readOpen(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) === "open"
  } catch {
    return false
  }
}

function writeOpen(key: string, open: boolean) {
  try {
    if (open) localStorage.setItem(PREFIX + key, "open")
    else localStorage.removeItem(PREFIX + key)
  } catch {
    // Storage is a convenience: the part still opens and closes for this visit.
  }
}

/** Whether a folded part is open: folded until the owner opens it; with `remember`, this browser keeps the choice. */
export function useFold(remember?: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => (remember ? readOpen(remember) : false))
  const change = (next: boolean) => {
    setOpen(next)
    if (remember) writeOpen(remember, next)
  }
  return [open, change]
}

/** The head's button: the chevron and the title; it names the body it opens. */
export function FoldButton({
  open,
  onToggle,
  controls,
  children,
}: {
  open: boolean
  onToggle: (open: boolean) => void
  controls: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="ui-fold-btn"
      aria-expanded={open}
      aria-controls={controls}
      onClick={() => onToggle(!open)}
    >
      <ChevronRight aria-hidden="true" className="ui-fold-chev" />
      {children}
    </button>
  )
}
