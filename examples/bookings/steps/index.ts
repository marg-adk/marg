/**
 * steps/index.ts — the runtime-owned moments of the booking journey.
 *
 * The Details card (date, party size, occasion) is a formStep with a `date` row. The Time chips
 * are a bespoke StepDefinition: the options come from the availability tool for the venue and
 * date on the draft; when the day has nothing free the chips are the nearest alternatives, and
 * picking one settles two slots (the time and the moved date). A wrong answer to either moment
 * would be a table booked on the wrong day, under the guest's name — so the runtime owns both.
 */
import { readChoice, stepHelpers, type StepContext, type StepDefinition, type StepRead, type StepSettled } from "@marg-adk/core";
import type { UiOption } from "@marg-adk/types";

const { formStep } = stepHelpers;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (day: string): string => {
  const d = new Date(day + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? day : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

const details = formStep({
  key: "details",
  label: "Details",
  lead: "When, and for how many?",
  title: "Booking details",
  submit: "Done",
  echo: "Details confirmed",
  asksLike: /\b(when\b[^.?!]*\bhow many|what (day|date)|which (day|date)|how many|party size|occasion)\b/i,
  rows: [
    { key: "date", label: "Date", kind: "date", required: true, say: "{v}" },
    { key: "party_size", label: "Party size", kind: "num", required: true, hint: "How many guests, including you", say: { one: "1 guest", many: "{v} guests" } },
    { key: "occasion", label: "Occasion", kind: "pick", options: [{ label: "Birthday", value: "birthday" }, { label: "Business", value: "business" }, { label: "Date night", value: "date night" }, { label: "Nothing special", value: "none" }], say: "" },
  ],
  check: (values) => {
    const errors: Record<string, string> = {};
    const n = Number(values.party_size);
    if (values.party_size && (!Number.isInteger(n) || n < 1 || n > 20)) errors.party_size = "A whole number from 1 to 20";
    return errors;
  },
});

/** The Time chips: open times on the date, or the nearest alternatives (which move the date too). */
const slot: StepDefinition = {
  key: "slot",
  label: "Time",
  owns: ["slot_time", "date"],
  dependsOn: ["details"],
  asksLike: /\b(what time|which time|when would you like|time slot)\b/i,
  still: "The time question below is still open.",
  async draw(ctx) {
    // the venue id is a record reference (hidden from the summary): the draft keeps it in refs
    const venue_id = ctx.draft.refs?.venue_id ?? ctx.draft.slots.venue_id;
    const { date, venue_name } = ctx.draft.slots as Record<string, string>;
    const r = ctx.json(await ctx.call("availability", { venue_id, date }));
    const slots: string[] = Array.isArray(r?.slots) ? r.slots : [];
    const alts: { date: string; time: string; label: string }[] = Array.isArray(r?.alternatives) ? r.alternatives : [];
    const options: UiOption[] = slots.length ? slots.map((t) => ({ label: t, value: t })) : alts.map((a) => ({ label: a.label, value: `${a.date} ${a.time}` }));
    const lead = slots.length
      ? `Which time on ${dayLabel(date)}?`
      : alts.length
        ? `Nothing free at ${venue_name ?? "the venue"} on ${dayLabel(date)}${r?.closed ? " (closed that day)" : ""} — the nearest:`
        : `Nothing free at ${venue_name ?? "the venue"} in the next two weeks — pick another day in the details.`;
    return { lead, ui: options.length ? [{ type: "chips", options }] : [], state: { options }, note: slots.length ? `Open times offered: ${slots.join(", ")}.` : `No times on ${date}; alternatives offered: ${alts.map((a) => a.label).join(", ") || "none"}.` };
  },
  read(ctx, message): StepRead {
    const options = (ctx.state?.options as UiOption[] | undefined) ?? [];
    const r = readChoice(message, options, { picking: true });
    if (r.type !== "pick") return { type: "words" };
    const [maybeDate, maybeTime] = r.option.value.split(" ");
    const values: Record<string, string> = maybeTime ? { slot_time: maybeTime, date: maybeDate } : { slot_time: r.option.value };
    return { type: "settle", values, via: maybeTime ? "alternative" : "answer" };
  },
  settle(ctx: StepContext, read): StepSettled {
    const date = read.values.date ?? String(ctx.draft.slots.date ?? "");
    const moved = Boolean(read.values.date);
    const slots: Record<string, string> = { slot_time: read.values.slot_time };
    if (moved) slots.date = date;
    return {
      say: moved ? `Moved to ${dayLabel(date)} at ${read.values.slot_time}.` : `Table at ${read.values.slot_time} on ${dayLabel(date)}.`,
      slots,
      note: `Time = ${read.values.slot_time}${moved ? ` on ${date} (moved from the requested day)` : ""}.`,
    };
  },
};

export const steps: StepDefinition[] = [details, slot];
export default steps;
