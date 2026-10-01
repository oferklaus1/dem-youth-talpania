"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link"
import {
  logContactAction,
  nextCardAction,
  progressAction,
  skipAction,
} from "../actions";
import {
  countdownText,
  firstName,
  formatWhen,
  historyChip,
  OUTCOME_LABEL,
  RSVP_LABEL,
} from "@/lib/format";
import type { CardState, Progress } from "@/lib/queries";
import type { ContactDraft, EventInfo, Outcome, QueueItem, Rsvp } from "@/lib/types";

/** חלון הביטול לפני שהתיעוד נכתב סופית */
const UNDO_MS = 5000;

const OUTCOMES: { value: Outcome; label: string; kind: string }[] = [
  { value: "answered", label: "ענה", kind: "k-sig" },
  { value: "no_answer", label: "לא ענה", kind: "k-no" },
  { value: "callback_later", label: "שיחזרו אליו", kind: "k-no" },
  { value: "opted_out", label: "אל תפנו אליי", kind: "k-alert" },
  { value: "awaiting_whatsapp", label: "שלחתי וואטסאפ — ממתין", kind: "k-wait" },
];

const RSVPS: { value: Exclude<Rsvp, "unknown">; label: string; kind: string }[] = [
  { value: "yes", label: "כן", kind: "k-yes" },
  { value: "maybe", label: "אולי", kind: "k-maybe" },
  { value: "no", label: "לא", kind: "k-no" },
];

/** תוצאות שסוגרות את המשימה — תואם ל-apply_contact_effects() במסד */
function closesAssignment(outcome: Outcome): boolean {
  return outcome === "answered" || outcome === "wrong_number" || outcome === "opted_out";
}

export default function CallCard({ event }: { event: EventInfo }) {
  const [card, setCard] = useState<QueueItem | null>(null);
  const [progress, setProgress] = useState<Progress>({
    done: 0,
    total: 0,
    mine: 0,
  });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  /**
   * כרטיסים שכבר טיפלתי בהם בסבב הזה.
   * נחוץ גם אחרי תיעוד: הכתיבה מושהית בגלל חלון הביטול, ובלי
   * ההחרגה הזו המסד היה מחזיר לי שוב את אותו אדם.
   */
  const [excluded, setExcluded] = useState<string[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);

  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    draft: ContactDraft;
  } | null>(null);

  /* ---------- טעינת הכרטיס הבא ---------- */

  useEffect(() => {
    let alive = true;
    nextCardAction(excluded).then((next: CardState) => {
      if (!alive) return;
      setCard(next.card);
      /* בזמן חלון ביטול המונה המקומי מקדים את המסד — אסור לדרוס אותו */
      if (!pending.current) {
        setProgress({ done: next.done, total: next.total, mine: next.mine });
      } else {
        setProgress((p) => ({ ...p, total: next.total }));
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [excluded]);

  /** מסיים את חלון הביטול וכותב למסד */
  const commit = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    setCanUndo(false);
    void logContactAction(p.draft).then(() =>
      progressAction().then(setProgress),
    );
  }, []);

  /* יציאה מהמסך לפני שחלף החלון — כותבים מיד */
  useEffect(() => commit, [commit]);




  /* ---------- פעולות ---------- */
  




  const handleSave = useCallback(
    (draft: ContactDraft, person: QueueItem) => {
      commit();

      /* המונים זזים מיד, והאמת מהמסד תחליף אותם אחרי הכתיבה */
      setProgress((p) => ({
        ...p,
        done: p.done + (closesAssignment(draft.outcome) ? 1 : 0),
        mine: p.mine + 1,
      }));

      setToast(
        `${firstName(person.fullName)} — ` +
          (draft.rsvp
            ? RSVP_LABEL[draft.rsvp as keyof typeof RSVP_LABEL]
            : OUTCOME_LABEL[draft.outcome]),
      );
      setCanUndo(true);

      pending.current = {
        draft,
        timer: setTimeout(() => {
          pending.current = null;
          setCanUndo(false);
          setToast(null);
          void logContactAction(draft).then(() =>
            progressAction().then(setProgress),
          );
        }, UNDO_MS),
      };

      setLoading(true);
      setExcluded((list) => [...list, draft.assignmentId]);
    },
    [commit],
  );

  const handleUndo = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    setCanUndo(false);
    setToast(null);

    setProgress((prev) => ({
      ...prev,
      done: prev.done - (closesAssignment(p.draft.outcome) ? 1 : 0),
      mine: prev.mine - 1,
    }));

    /* הסרה מההחרגה מחזירה את אותו כרטיס — הוא עדיין תפוס בשמי */
    setLoading(true);
    setExcluded((list) => list.filter((id) => id !== p.draft.assignmentId));
  }, []);

  const handleSkip = useCallback(async (assignmentId: string) => {
    setLoading(true);
    await skipAction(assignmentId);
    setSkippedCount((n) => n + 1);
    setExcluded((list) => [...list, assignmentId]);
  }, []);

  /* ---------- תצוגה ---------- */

  const { done, total, mine } = progress;
  const pct = total ? (done / total) * 100 : 0;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>{event.title}</h1>
          <div className="when">
            {formatWhen(event.startsAt, event.location)} ·{" "}
            <b>{countdownText(event.startsAt)}</b>
          </div>
        </div>

        <div className="meter">
          <div className="meter-head">
            <span>התקדמות כללית</span>
            <b>
              {done} מתוך {total}
            </b>
          </div>
          <div
            className="track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="meter-sub">תיעדתי {mine} שיחות</div>
        </div>
      </header>

      <div className="scroll">
        {loading && <p className="empty">טוען…</p>}

        {!loading && !card && (
          <p className="empty">
            אין למי להתקשר כרגע.
            <br />
            {skippedCount > 0
              ? "דילגת על כל מי שנשאר — רענן את הדף כדי לקבל אותם שוב."
              : "כל השיחות בפעולה הזו נעשו."}
          </p>
        )}

        {!loading && card && (
          <Card
            key={card.assignmentId}
            person={card}
            onSave={handleSave}
            onSkip={handleSkip}
          />
        )}
      </div>

      <div className={"toast" + (toast ? " open" : "")} role="status">
        <span>{toast}</span>
        {canUndo && (
          <button type="button" onClick={handleUndo}>
            בטל
          </button>
        )}
      </div>

    </>
  );
}

/* ------------------------------------------------------------------ */

function Card({
  person,
  onSave,
  onSkip,
}: {
  person: QueueItem;
  onSave: (draft: ContactDraft, person: QueueItem) => void;
  onSkip: (assignmentId: string) => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [rsvp, setRsvp] = useState<Exclude<Rsvp, "unknown"> | null>(null);
  const [needsRide, setNeedsRide] = useState(false);

  const needsRsvp = outcome === "answered";
  const canSave = outcome !== null && (!needsRsvp || rsvp !== null);
  const chip = historyChip(person);

  /**
   * בטלפון הקישור פשוט עובד. בתצוגה מוטמעת בתוך מסגרת, פתיחת לשונית
   * חדשה חסומה — לכן מנסים לשונית, אחר כך ניווט של החלון החיצוני.
   */
  function openExternal(e: React.MouseEvent<HTMLAnchorElement>) {
    const url = e.currentTarget.href;
    let win: Window | null = null;
    try {
      win = window.open(url, "_blank", "noopener");
    } catch {
      win = null;
    }
    if (win) {
      e.preventDefault();
      return;
    }
    try {
      if (window.top && window.top !== window) {
        window.top.location.href = url;
        e.preventDefault();
      }
    } catch {
      /* חוצה-מקור — נופלים לניווט הרגיל */
    }
  }
  const maleMsg = encodeURIComponent(`שלום , רציתי לשאול לגבי...`);
  return (
    <div className="card">
      <div className="card-id">
        <h2>{person.fullName}</h2>
        <div className="sub">
          {person.grade ? <span>שכבה {person.grade}׳</span> : null}
          <span className={"chip " + chip.cls}>{chip.text}</span>
        </div>
        {person.note && <div className="sub">{person.note}</div>}
        <div className="phone" dir="ltr">
          {person.phoneE164}
        </div>
      </div>

      <div className="reach">
        <a className="call" href={`tel:${person.phoneE164}`}>
          חייג
        </a>
        <a
          className="wa"
          href={`https://wa.me/${person.phoneE164.replace("+", "")}?text=${maleMsg}`}
          //target="_top"
          rel="noopener"
          onClick={openExternal}
        >
          וואטסאפ
        </a>
      </div>

      <p className="ask">מה קרה בשיחה?</p>
      <div className="opts two">
        {OUTCOMES.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`opt ${o.kind}`}
            aria-pressed={outcome === o.value}
            onClick={() => {
              setOutcome(o.value);
              if (o.value !== "answered") {
                setRsvp(null);
                setNeedsRide(false);
              }
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {needsRsvp && (
        <>
          <p className="ask">מגיע לפעולה?</p>
          <div className="opts three">
            {RSVPS.map((r) => (
              <button
                key={r.value}
                type="button"
                className={`opt ${r.kind}`}
                aria-pressed={rsvp === r.value}
                onClick={() => setRsvp(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="ride"
            aria-pressed={needsRide}
            onClick={() => setNeedsRide((v) => !v)}
          >
            <span className="box" aria-hidden="true">
              {needsRide ? "✓" : ""}
            </span>
            צריך הסעה
          </button>
        </>
      )}

      <button
        type="button"
        className="save"
        disabled={!canSave}
        onClick={() =>
          onSave(
            {
              assignmentId: person.assignmentId,
              outcome: outcome!,
              rsvp: needsRsvp ? rsvp : null,
              needsRide: needsRsvp ? needsRide : false,
            },
            person,
          )
        }
      >
        שמור והבא
      </button>

      <button
        type="button"
        className="linkish"
        onClick={() => onSkip(person.assignmentId)}
      >
        דלג — אחזור אליו אחר כך
      </button>
    </div>
  );
}
