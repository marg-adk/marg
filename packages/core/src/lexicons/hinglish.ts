/**
 * lexicons/hinglish.ts — the Hindi and Hinglish register of the readers: the words, the rewrite
 * rules and the question markers that were in the core until 0.2, moved here as an opt-in
 * extension. This is the register the blind-corpus numbers were measured with (521 replies: a
 * leading-word reader mis-read 235, the whole-content reader 0; the lexicon swallowed 0 of 267
 * non-yes messages). Load it with `AGENT_LEXICONS=hinglish` or `loadLexicons(["hinglish"])`.
 *
 * Every entry is a word that cannot carry content on its own (politeness, address, hesitation,
 * the verbs of "do it"), a confirm or refusal word, or a phrase that means one English token
 * (ok, change, later, proceed, maybe, no). Widen with the same care: a blind corpus first.
 */
import { extendLexicon, type LexiconExtension } from "../reply-words.js";

export const hinglish: LexiconExtension = {
  neutral: ("hai hain ho kar karo de dena rakho rakhna chalega chalo bhai ji jee kardo karde kijiye dijiye kariye karein karlo karni kuch " +
    "hi ye yeh yahi wahi woh vo pe par ke liye bas toh na isko ise usko thoda ek baar pehle arey arre yaar h bhaiya sab sabhi").split(" "),
  confirm: "haan han ha haa bilkul sahi theek thik accha acha achha".split(" "),
  softAck: "accha acha achha".split(" "),
  refuse: "nahi nai nahin nahii nahee nahh nhi nahan galat badlo badal badalna".split(" "),
  refuseNeutral: "arre kar karo karna de kardo karde kijiye dijiye kariye karein karlo karni".split(" "),
  noChangeNext: "karo kar kare kijiye kardo karde dijiye kariye karein banao bana".split(" "),
  rewrites: [
    // "change nahi karna", "galat nahi", "kuch badalna nahi" → no change needed
    [/\b(?:koi\s+|kuch\s+)?(?:change|changes|badal\w*|badlo)\s+(?:nahi|nahin|nai|nhi|mat)\b|\bmat\s+(?:change|badal\w*|badlo)\b|\b(?:galat|wrong|incorrect)\s+(?:nahi|nahin|nhi|nai)\b|\bnothing\s+(?:is\s+)?galat\b/g, " ok "],
    // "theek kar do", "sahi karo", "correct kar dijiye" → change it
    [/\b(?:isko|ise|usko|ye|yeh|sab|sabhi|price|rent|deposit|amount)?\s*(?:theek|thik|sahi|correct|right)\s+(?:kar|karo|kardo|karna|karde|kijiye|kijie|dijiye|kariye|karein|kare|bana|banao|banado|banana)\b/g, " change "],
    // "abhi ke liye" → later
    [/\babhi\s+ke\s+liye\b/g, " later "],
    // "aage badho", "agla step" → proceed
    [/\baage\s+(?:badho|badhao|badhiye|badhna|chalo)\b|\bagle?\s+step\b/g, " proceed "],
    // "hoga", "hai na" → maybe
    [/\b(?:hoga|hogi|honge|hai na|hain na)\b/g, " maybe "],
    // "na karo", "bas kar do" → no
    [/\b(?:na|bas)\s*,?\s*(?:kar|karo|karna|kardo|karde|kare|karein|kariye|kijiye|kijie|dijiye|banao|bana|banado|banana)\b/g, " no "],
  ],
  questionOpeners: "kya kyun kyu".split(" "),
  questionLeads: "bhai haan accha acha".split(" "),
  cutOffs: "par aur lekin magar".split(" "),
  unfinishedTails: [["ek", "baat"]],
  questionExceptions: [
    // "is ko", "is ke liye": "is" is the pronoun "this", not the English opener
    (first, second) => first === "is" && /^(?:ko|se|ka|ki|ke|pe|par|mein|me|liye)$/.test(second ?? ""),
    // "are bhai", "are haan": an interjection, not "are you…"
    (first, second) => first === "are" && /^(?:bhai|yaar|haan|han|ok|okay|sir)$/.test(second ?? ""),
  ],
  skipPhrases: [/^\s*(?:not|nahi|nahin|nhi)\s+abhi\s*[.!]*\s*$/i, /^\s*abhi\s+(?:nahi|nahin|nhi)\s*[.!]*\s*$/i],
};

/** Load the register for this process. */
export function loadHinglish(): void {
  extendLexicon(hinglish);
}
