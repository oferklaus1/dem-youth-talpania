"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * הלשוניות התחתונות.
 *
 * "הפעולה" היא מסך רכז ומוצגת רק לו. שתי האחרות שייכות לטלפן:
 * המסך שבו מחייגים, והספרייה של מי שממתין לתשובה בוואטסאפ.
 * בלי הספרייה בלשוניות אין לטלפן רגיל שום דרך להגיע אליה.
 */
export default function TabBar({
  isAdmin,
  waitingCount,
}: {
  isAdmin: boolean;
  waitingCount: number;
}) {
  const pathname = usePathname();

  const tabs = [
    { href: "/", glyph: "☰", label: "השיחות שלי", badge: 0 },
    { href: "/waiting", glyph: "◔", label: "עדכון וואטסאפים", badge: waitingCount },
    { href: "/custom-message", glyph: "✏️", label: "הודעה מותאמת", badge: 0 },
    ...(isAdmin ? [{ href: "/event", glyph: "◑", label: "הפעולה", badge: 0 }] : []),
  ];

  return (
    <nav className="tabs" aria-label="ניווט ראשי">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={pathname === tab.href ? "page" : undefined}
        >
          <span className="glyph" aria-hidden="true">
            {tab.glyph}
            {tab.badge > 0 && <span className="badge">{tab.badge}</span>}
          </span>
          <span className="tab-label">
            {tab.label}
            {tab.badge > 0 && (
              <span className="sr-only"> — {tab.badge} ממתינים לתשובה</span>
            )}
          </span>
        </Link>
      ))}
    </nav>
  );
}
