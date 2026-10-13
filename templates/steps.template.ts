/**
 * steps/index.ts — the runtime-owned moments of the __NAME__ journey.
 *
 * Decide per moment: what does a wrong answer cost? Values published under the user's name,
 * required questions, confirmations — runtime steps. Free text and corrections — the model.
 * Built from the three helpers; implement StepDefinition directly for a bespoke moment.
 */
import { stepHelpers, type StepDefinition } from "@marg/core";

const { chipsStep, formStep } = stepHelpers;

export const steps: StepDefinition[] = [
  formStep({
    key: "details",
    label: "Details",
    lead: "A few details:",
    title: "Details",
    submit: "Done",
    echo: "Details confirmed",
    asksLike: /\b(detail|details)\b/i,
    rows: [
      { key: "kind", label: "Kind", kind: "pick", required: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], say: "{v}" },
      { key: "notes", label: "Notes", kind: "text", say: "" },
    ],
  }),
  chipsStep({
    key: "priority",
    label: "Priority",
    slot: "priority",
    lead: "How urgent is this?",
    options: [{ label: "Low", value: "low" }, { label: "High", value: "high" }],
    say: "Priority set to {v}.",
    asksLike: /\b(priority|urgent)\b/i,
    dependsOn: ["details"],
  }),
];

export default steps;
