import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

type DrawerProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
};

/**
 * A panel that slides in from the right. Its content stays mounted while closed so
 * settings keep loading and reporting to the app, but it is inert and off screen.
 */
function Drawer({ open, title, onClose, wide = false, children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        aria-hidden="true"
        className={`scrim ${open ? "scrim--open" : ""}`}
        onClick={onClose}
      />
      <aside
        aria-label={title}
        className={`drawer ${wide ? "drawer--wide" : ""} ${open ? "drawer--open" : ""}`}
        inert={!open}
      >
        <header className="drawer__header">
          <h2>{title}</h2>
          <button
            aria-label={`Close ${title.toLowerCase()}`}
            className="icon-button icon-button--subtle"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="drawer__body">{children}</div>
      </aside>
    </>
  );
}

export default Drawer;
