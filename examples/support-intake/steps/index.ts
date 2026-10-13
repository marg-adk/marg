/**
 * steps/index.ts — the runtime-owned moments of the support-intake journey.
 *
 * Two steps, composed from the core helpers: a FORM (the details an engineer needs — the model
 * would otherwise ask them one by one, or forget half) and a CHIPS question (priority — a value
 * published on the ticket, so it must come from the user's own tap, never a model's guess).
 * Both are drawn after the model's gathering is valid, read in code, written to the draft and
 * carried into every validate/preview/create call.
 */
import { stepHelpers, type StepDefinition } from "@marg-adk/core";

const { chipsStep, formStep } = stepHelpers;

export const steps: StepDefinition[] = [
  formStep({
    key: "details",
    label: "Details",
    lead: "A few details an engineer will need:",
    title: "Ticket details",
    submit: "Done",
    echo: "Details confirmed",
    asksLike: /\b(environment|reproduce|affected|how many users|steps)\b/i,
    rows: [
      { key: "environment", label: "Environment", kind: "pick", required: true, options: [{ label: "Production", value: "production" }, { label: "Staging", value: "staging" }, { label: "Local", value: "local" }], say: "{v}" },
      { key: "affected_users", label: "Affected users", kind: "num", hint: "Roughly how many people are affected", say: { one: "1 user affected", many: "{v} users affected" } },
      { key: "steps_to_reproduce", label: "Steps to reproduce", kind: "text", required: true, say: "" },
    ],
    check: (values): Record<string, string> => (values.steps_to_reproduce && values.steps_to_reproduce.trim().length < 8 ? { steps_to_reproduce: "A little more detail, please" } : {}),
  }),
  chipsStep({
    key: "priority",
    label: "Priority",
    slot: "priority",
    lead: "How urgent is this?",
    options: async (ctx) => {
      const r = ctx.json(await ctx.call("reference_data", { kind: "priorities" }));
      const list: string[] = Array.isArray(r?.options) ? r.options : ["low", "medium", "high", "urgent"];
      return list.map((v) => ({ label: v.charAt(0).toUpperCase() + v.slice(1), value: v }));
    },
    say: "Priority set to {v}.",
    asksLike: /\b(priority|urgent|urgency|how urgent)\b/i,
    dependsOn: ["details"],
  }),
];

export default steps;
