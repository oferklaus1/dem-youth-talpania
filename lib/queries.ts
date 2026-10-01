import "server-only";
import { cookies } from "next/headers";
import { db } from "./db";
import {
  ADMIN_COOKIE,
  isAdminSession,
  readSessionValue,
  SESSION_COOKIE,
} from "./session";
import type {
  Caller,
  CallerProgress,
  ContactDraft,
  EventInfo,
  EventStats,
  Outcome,
  QueueItem,
  Rsvp,
  UpcomingCampaign,
} from "./types";

/* ------------------------------------------------------------------ */
/* מי מחובר                                                            */
/* ------------------------------------------------------------------ */

export async function getCallers(): Promise<Caller[]> {
  const { data, error } = await db
    .from("profiles")
    .select("id, display_name")
    .eq("is_active", true)
    .order("created_at");

  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({ id: p.id, name: p.display_name }));
}

/** הטלפן המחובר, או null אם העוגייה מצביעה על מי שכבר לא קיים */
export async function getCurrentCaller(): Promise<Caller | null> {
  const store = await cookies();
  const id = await readSessionValue(store.get(SESSION_COOKIE)?.value);
  if (!id) return null;

  const { data } = await db
    .from("profiles")
    .select("id, display_name")
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle();

  return data ? { id: data.id, name: data.display_name } : null;
}

export async function getIsAdmin(): Promise<boolean> {
  const store = await cookies();
  return isAdminSession(store.get(ADMIN_COOKIE)?.value);
}

/* ------------------------------------------------------------------ */
/* הפעולה                                                              */
/* ------------------------------------------------------------------ */

export async function getActiveEvent(): Promise<EventInfo | null> {
  const upcoming = await db
    .from("events")
    .select("id, title, starts_at, location, target_count")
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const row =
    upcoming.data ??
    (
      await db
        .from("events")
        .select("id, title, starts_at, location, target_count")
        .order("starts_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ).data;

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    location: row.location,
    targetCount: row.target_count,
  };
}

/* ------------------------------------------------------------------ */
/* המאגר המשותף                                                        */
/* ------------------------------------------------------------------ */

/* חלון התפיסה — עשר דקות — נאכף בפונקציה next_assignment שבמסד,
   לא כאן. ראה supabase/next-card.sql */

type ContactRow = {
  outcome: Outcome;
  rsvp: Rsvp | null;
  needs_ride: boolean;
  contacted_at: string;
};

type AssignmentRow = {
  id: string;
  state: "pending" | "done" | "skipped";
  assigned_to: string | null;
  claimed_at: string | null;
  person_id: string;
  people: {
    full_name: string;
    phone_e164: string;
    grade: string | null;
    notes: string | null;
  } | null;
  contacts: ContactRow[];
};

const SELECT =
  "id, state, assigned_to, claimed_at, person_id, " +
  "people ( full_name, phone_e164, grade, notes ), " +
  "contacts ( outcome, rsvp, needs_ride, contacted_at )";

function latest(contacts: ContactRow[]): ContactRow | null {
  if (!contacts.length) return null;
  return [...contacts].sort((a, b) =>
    a.contacted_at < b.contacted_at ? 1 : -1,
  )[0];
}

function toItem(
  row: AssignmentRow,
  history: Map<string, { attended: number; total: number }>,
): QueueItem {
  const last = latest(row.contacts ?? []);
  const h = history.get(row.person_id) ?? { attended: 0, total: 0 };
  return {
    assignmentId: row.id,
    personId: row.person_id,
    fullName: row.people!.full_name,
    phoneE164: row.people!.phone_e164,
    grade: row.people!.grade,
    note: row.people!.notes,
    state: row.state,
    lastOutcome: last?.outcome ?? null,
    lastRsvp: last?.rsvp ?? null,
    lastNeedsRide: last?.needs_ride ?? false,
    attendedCount: h.attended,
    totalEvents: h.total,
  };
}

/** "הגיע ב-3 מ-4 האחרונות" — נבנה מפעולות קודמות */
async function historyFor(
  personIds: string[],
  exceptEventId: string,
): Promise<Map<string, { attended: number; total: number }>> {
  const out = new Map<string, { attended: number; total: number }>();
  if (!personIds.length) return out;

  const { data } = await db
    .from("assignments")
    .select("person_id, contacts ( rsvp )")
    .in("person_id", personIds)
    .neq("event_id", exceptEventId);

  for (const row of (data ?? []) as unknown as {
    person_id: string;
    contacts: { rsvp: Rsvp | null }[];
  }[]) {
    if (!row.contacts?.length) continue;
    const entry = out.get(row.person_id) ?? { attended: 0, total: 0 };
    entry.total += 1;
    if (row.contacts.some((c) => c.rsvp === "yes")) entry.attended += 1;
    out.set(row.person_id, entry);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* תפיסה, שחרור, תיעוד                                                 */
/* ------------------------------------------------------------------ */

export type Progress = { done: number; total: number; mine: number };

export async function getProgress(
  callerId: string,
  eventId: string,
): Promise<Progress> {
  const [{ data: rows }, { data: mine }] = await Promise.all([
    db.from("assignments").select("id, state").eq("event_id", eventId),
    db
      .from("contacts")
      .select("id, assignment_id, assignment:assignments!inner(event_id)")
      .eq("contacted_by", callerId)
      .eq("assignment.event_id", eventId),
  ]);

  const all = rows ?? [];
  return {
    done: all.filter((r) => r.state === "done").length,
    total: all.filter((r) => r.state !== "skipped").length,
    /* לפי משימות ולא לפי רשומות: מי שסומן כממתין לוואטסאפ ואז תועד
       שוב רטרואקטיבית מייצר שתי רשומות על אותו אדם */
    mine: new Set((mine ?? []).map((r) => r.assignment_id)).size,
  };
}

export type CardState = {
  card: QueueItem | null;
  /** כמה שיחות נעשו בסך הכל בפעולה */
  done: number;
  total: number;
  /** כמה תיעדתי אני */
  mine: number;
};

/**
 * מוסר לטלפן את הפעיל הבא ותופס אותו עבורו.
 * exclude — כרטיסים שהמתקשר דילג עליהם בסבב הנוכחי.
 */
export async function getNextCard(
  callerId: string,
  eventId: string,
  exclude: string[] = [],
): Promise<CardState> {
  const { data: nextId, error } = await db.rpc("next_assignment", {
    p_event: eventId,
    p_profile: callerId,
    p_exclude: exclude,
  });
  if (error) throw new Error(error.message);

  const progress = await getProgress(callerId, eventId);

  if (!nextId) return { card: null, ...progress };

  const { data } = await db
    .from("assignments")
    .select(SELECT)
    .eq("id", nextId)
    .maybeSingle();

  const row = data as unknown as AssignmentRow | null;
  if (!row?.people) return { card: null, ...progress };

  const history = await historyFor([row.person_id], eventId);
  return { card: toItem(row, history), ...progress };
}

export async function releaseAssignment(
  callerId: string,
  assignmentId: string,
): Promise<void> {
  await db.rpc("release_assignment", {
    p_assignment: assignmentId,
    p_profile: callerId,
  });
}

export async function insertContact(
  callerId: string,
  draft: ContactDraft,
): Promise<void> {
  /* המפתח עוקף RLS, ולכן בדיקת הבעלות הזו היא ההגנה היחידה */
  const { data: owned } = await db
    .from("assignments")
    .select("id")
    .eq("id", draft.assignmentId)
    .eq("assigned_to", callerId)
    .maybeSingle();

  if (!owned) throw new Error("הכרטיס כבר לא שלך");

  const { error } = await db.from("contacts").insert({
    assignment_id: draft.assignmentId,
    contacted_by: callerId,
    outcome: draft.outcome,
    rsvp: draft.rsvp ?? "unknown",
    needs_ride: draft.needsRide,
  });

  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/* דשבורד                                                              */
/* ------------------------------------------------------------------ */

/** פעיל שכמה טלפנים דילגו עליו ואיש לא התקשר אליו */
export type NeglectedPerson = {
  fullName: string;
  phoneE164: string;
  note: string | null;
  skipCount: number;
  skippedBy: number;
};

export async function getNeglected(
  eventId: string,
): Promise<NeglectedPerson[]> {
  const { data, error } = await db
    .from("neglected_people")
    .select("full_name, phone_e164, notes, skip_count, skipped_by")
    .eq("event_id", eventId);

  /* אם התצוגה עוד לא קיימת במסד, לא מפילים את הדשבורד בגללה */
  if (error) return [];

  return (data ?? []).map((r) => ({
    fullName: r.full_name,
    phoneE164: r.phone_e164,
    note: r.notes,
    skipCount: r.skip_count,
    skippedBy: r.skipped_by,
  }));
}

export async function getEventDashboard(eventId: string): Promise<{
  stats: EventStats;
  callers: CallerProgress[];
}> {
  const [{ data: rows }, { data: profiles }] = await Promise.all([
    db.from("assignments").select(SELECT).eq("event_id", eventId),
    db.from("profiles").select("id, display_name").eq("is_active", true),
  ]);

  const assignments = ((rows ?? []) as unknown as AssignmentRow[]).filter(
    (r) => r.state !== "skipped",
  );
  const names = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  const stats: EventStats = {
    assigned: assignments.length,
    reached: 0,
    answered: 0,
    rsvpYes: 0,
    rsvpMaybe: 0,
    rsvpNo: 0,
    needsRide: 0,
  };

  /* בלי חלוקה מראש אין "כמה נשאר לו" — יש רק כמה כל אחד תרם */
  const perCaller = new Map<string, { reached: number; rsvpYes: number }>();

  for (const a of assignments) {
    const last = latest(a.contacts ?? []);
    if (!last) continue;

    stats.reached += 1;
    if (last.outcome === "answered") stats.answered += 1;
    if (last.rsvp === "yes") stats.rsvpYes += 1;
    if (last.rsvp === "maybe") stats.rsvpMaybe += 1;
    if (last.rsvp === "no") stats.rsvpNo += 1;
    if (last.needs_ride) stats.needsRide += 1;

    if (a.assigned_to) {
      const entry = perCaller.get(a.assigned_to) ?? { reached: 0, rsvpYes: 0 };
      entry.reached += 1;
      if (last.rsvp === "yes") entry.rsvpYes += 1;
      perCaller.set(a.assigned_to, entry);
    }
  }

  const callers: CallerProgress[] = [...names.entries()]
    .map(([id, name]) => ({
      profileId: id,
      displayName: name,
      assigned: 0,
      reached: perCaller.get(id)?.reached ?? 0,
      rsvpYes: perCaller.get(id)?.rsvpYes ?? 0,
      isSelf: false,
    }))
    .sort((a, b) => b.reached - a.reached);

  return { stats, callers };
}

/* ------------------------------------------------------------------ */
/* יצירת קמפיין                                                        */
/* ------------------------------------------------------------------ */

export type CampaignInput = {
  title: string;
  startsAt: string; // ISO
  location: string | null;
  targetCount: number | null;
};

/**
 * יוצר קמפיין וממלא את רשימת השיחות שלו.
 *
 * שני הצעדים חייבים לקרות יחד: קמפיין בלי generate_assignments הוא
 * מסך ריק שאי אפשר לחייג ממנו, ואין בממשק דרך להשלים את זה אחר כך.
 */
export async function createCampaign(
  input: CampaignInput,
  createdBy: string,
): Promise<{ id: string; assigned: number }> {
  const { data, error } = await db
    .from("events")
    .insert({
      title: input.title,
      starts_at: input.startsAt,
      location: input.location,
      target_count: input.targetCount,
      assignment_strategy: "pool",
      created_by: createdBy,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  const { data: assigned, error: genError } = await db.rpc(
    "generate_assignments",
    { p_event_id: data.id },
  );

  if (genError) throw new Error(genError.message);

  return { id: data.id, assigned: Number(assigned ?? 0) };
}

/**
 * הקמפיינים שעוד לא עברו. נחוץ בממשק כדי שהרכז יבין למה המסך לא
 * השתנה אחרי שיצר קמפיין רחוק — האפליקציה מציגה תמיד את הקרוב.
 */
export async function getUpcomingCampaigns(): Promise<UpcomingCampaign[]> {
  const { data, error } = await db
    .from("events")
    .select("id, title, starts_at, location, target_count, assignments(count)")
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(20);

  if (error) return [];

  type Row = {
    id: string;
    title: string;
    starts_at: string;
    location: string | null;
    target_count: number | null;
    assignments: { count: number }[] | null;
  };

  return ((data ?? []) as unknown as Row[]).map((row, i) => ({
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    location: row.location,
    targetCount: row.target_count,
    isActive: i === 0,
    callCount: row.assignments?.[0]?.count ?? 0,
  }));
}

/* ------------------------------------------------------------------ */
/* הספרייה: מי שממתין לתשובה בוואטסאפ                                  */
/* ------------------------------------------------------------------ */

/**
 * שורה ב-awaiting_whatsapp_queue.
 * ראה supabase/awaiting-whatsapp.sql — אלה יורדים מהמאגר המשותף
 * ושמורים לטלפן שסימן אותם בלבד.
 */
export type AwaitingItem = {
  assignmentId: string;
  personId: string;
  fullName: string;
  phoneE164: string;
  grade: string | null;
  note: string | null;
  /** מתי נשלחה ההודעה שממתינים לתשובה עליה */
  waitingSince: string;
};

export async function getAwaiting(
  callerId: string,
  eventId: string,
): Promise<AwaitingItem[]> {
  const { data, error } = await db
    .from("awaiting_whatsapp_queue")
    .select(
      "assignment_id, person_id, full_name, phone_e164, grade, notes, waiting_since",
    )
    .eq("owner_profile_id", callerId)
    .eq("event_id", eventId)
    .order("waiting_since", { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => ({
    assignmentId: r.assignment_id as string,
    personId: r.person_id as string,
    fullName: r.full_name as string,
    phoneE164: r.phone_e164 as string,
    grade: r.grade as string | null,
    note: r.notes as string | null,
    waitingSince: r.waiting_since as string,
  }));
}

/** רק המספר — ללשונית. שאילתת ספירה, בלי להביא את השורות עצמן. */
export async function getAwaitingCount(
  callerId: string,
  eventId: string,
): Promise<number> {
  const { count } = await db
    .from("awaiting_whatsapp_queue")
    .select("assignment_id", { count: "exact", head: true })
    .eq("owner_profile_id", callerId)
    .eq("event_id", eventId);

  return count ?? 0;
}

/**return the list of people awaiting whatsapp message*/
export async function getAllAwaiting(
  eventId: string,
): Promise<AwaitingItem[]>{
  const { data, error } = await db
    .from("awaiting_whatsapp_queue")
    .select(
      "assignment_id, person_id, full_name, phone_e164, grade, notes, waiting_since",
    )
    .eq("event_id", eventId)
    .order("waiting_since", { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => ({
    assignmentId: r.assignment_id as string,
    personId: r.person_id as string,
    fullName: r.full_name as string,
    phoneE164: r.phone_e164 as string,
    grade: r.grade as string | null,
    note: r.notes as string | null,
    waitingSince: r.waiting_since as string,
  }));
}

