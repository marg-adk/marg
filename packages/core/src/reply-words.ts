/**
 * reply-words.ts — what a typed reply may say and still be ONLY a yes or a no (pure, no imports).
 *
 * THE RULE. A typed reply is read by its WHOLE content, never by its first word. "Keep this
 * private please" starts with "keep" and is about something else; "No, create it later" starts
 * with "no" and is a refusal that a leading-word reader took for a go-ahead. A reply is a plain
 * yes only when every word in it is a confirm word, politeness or a content-free filler; a plain
 * no likewise. Anything else is CONTENT — an instruction, a fact, a question, a correction — and
 * the code that would have acted on a bare yes must leave it for the model (who answers it while
 * the runtime's question is drawn again) instead of dropping it.
 *
 * Measured on a blind corpus of 521 realistic replies, with the Hinglish register loaded: a
 * leading-word reader took 235 messages that were really something else for a bare confirm or
 * refusal; this reader took 0.
 *
 * The cost is asymmetric: a false "words" makes the user repeat a yes; a false yes settles a
 * value or — at the create gate — performs a real write. So the vocabulary is widened only with
 * words that cannot carry content on their own, phrases that LOOK like a yes but are a hand-off
 * ("let me confirm", "will confirm", "i am done", "correct it") are rewritten into non-yes tokens
 * in `wordsOf`, and a question or a message cut off after a connector is never a bare yes.
 *
 * THE CORE IS ENGLISH. A register (a language, a dialect, a team's vocabulary) is a lexicon: words
 * plus rewrite rules plus question markers, loaded with `extendLexicon` — `lexicons/hinglish.ts`
 * is the one the numbers above were measured with (`AGENT_LEXICONS=hinglish`, or
 * `loadLexicons(["hinglish"])` at boot). Widening the yes-vocabulary is what opens holes: add only
 * words that cannot carry content (docs/guides/readers.md).
 */

/** Words that carry no content: politeness, address, hesitation, the nouns of the question itself, restating words. */
export const NEUTRAL = new Set(("please pls plz thanks thank thx thankyou you u it its that thats this is was a an the as and so now then just all for one same going looks sounds " +
  "do sir boss madam mam maam hmm hm well uh um oh ah price rent deposit amount figure asking rate number value " +
  "entered said given shown mentioned typed month monthly per pm mo lot much very really too final only exact fixed " +
  "on move lets let us with to of at by are were can may would could i am im we be kindly everything details summary me my bro course totally thing means " +
  "know aware intentional deliberate certain high above below bit slightly somewhat little quite expensive costly pricey premium low side about " +
  "ofcourse surely certainly indeed obviously acceptable happy").split(" "));

/** Words that make a reply a yes. */
export const CONFIRM_WORDS = new Set(("keep yes yeah yep yup yea correct right ok okay confirm confirmed sure fine perfect exactly absolutely definitely " +
  "good great proceed done agreed agree accept accepted approved ya yaa yah " +
  "continue next carry cool nice noted understood got alright works " +
  "certainly surely indeed obviously acceptable ofcourse").split(" "));

/** Acknowledgements and praise: a yes beside other words ("yes, noted") but never a go-ahead on their own where a false yes costs. */
export const SOFT_ACK = new Set("good great nice cool noted understood got alright works next carry keep".split(" "));

/** Tails a carry-on may have ("yes proceed to the next step") — a yes reader's only; never a refusal reader's. */
export const YES_TAIL = new Set("step steps process forward further immediately asap away".split(" "));

/** Words that make a reply a no / "change it". */
export const REFUSE_WORDS = new Set("no nope nah not wrong incorrect change edit different actually wait hold redo isnt dont".split(" "));

/** Content-free words that may travel with a refusal ("let me change it", "no that's not right"). */
export const REFUSE_NEUTRAL = new Set("right correct true new another other again let me i want to would like ill give tell make say put set will fix update modify alter sorry oops oh do".split(" "));

const YES_ONLY = new Set("know aware intentional deliberate certain high above below happy ofcourse surely certainly indeed obviously acceptable much very too final fixed exact only lot at bit slightly somewhat little quite expensive costly pricey premium low side about".split(" "));
export const REFUSE_FILL = new Set([...NEUTRAL].filter((x) => !YES_ONLY.has(x)));

/** What may follow "no change(s)" for it to mean "no change needed" — an object after it ("no change the price") is "no, change …". */
const NO_CHANGE_NEXT = new Set("it this that the my our price rent deposit amount figure rate asking number value please pls plz do".split(" "));

/** Rewrite rules a register adds to `wordsOf` (applied after the normalisation, before the English rules). */
const REWRITES: [RegExp, string][] = [];
const QUESTION_OPENERS = new Set("is are was were does did should could would what whats why how hows which when where who whom whose".split(" "));
const QUESTION_LEAD = new Set("ok okay yes yeah yep sure sir hmm hm so well boss please pls plz and then".split(" "));
const CUT_OFF = new Set("so and also but however though".split(" "));
/** Two-word tails that mean the sentence is not finished ("yes, one thing"). */
const UNFINISHED_TAILS: [string, string][] = [["one", "thing"]];
/** A register's "this opener is not a question here" rules, given the first two words. */
const QUESTION_EXCEPTIONS: ((first: string, second: string | undefined) => boolean)[] = [];
/** Whole-message skip phrases a register adds ("not now" is English's). */
const SKIP_PHRASES: RegExp[] = [/^\s*not\s+now\s*[.!]*\s*$/i];

export interface LexiconExtension {
  neutral?: string[];
  confirm?: string[];
  refuse?: string[];
  refuseNeutral?: string[];
  softAck?: string[];
  /** Words that may follow "no change(s)" and keep it meaning "no change needed". */
  noChangeNext?: string[];
  /** Rewrite rules for `wordsOf`: a phrase of the register → the English token it means (ok, change, later, proceed, maybe, no). */
  rewrites?: [RegExp, string][];
  questionOpeners?: string[];
  questionLeads?: string[];
  cutOffs?: string[];
  unfinishedTails?: [string, string][];
  questionExceptions?: ((first: string, second: string | undefined) => boolean)[];
  skipPhrases?: RegExp[];
}

/**
 * Add a register: your users' own vocabulary, rewrite rules and question markers. Add only words
 * that cannot carry content on their own — every widening is a hole at the create gate. Measure
 * on a blind corpus before shipping a register (docs/guides/readers.md).
 */
export function extendLexicon(add: LexiconExtension): void {
  for (const w of add.neutral ?? []) NEUTRAL.add(w.toLowerCase());
  for (const w of add.confirm ?? []) CONFIRM_WORDS.add(w.toLowerCase());
  for (const w of add.refuse ?? []) REFUSE_WORDS.add(w.toLowerCase());
  for (const w of add.refuseNeutral ?? []) REFUSE_NEUTRAL.add(w.toLowerCase());
  for (const w of add.softAck ?? []) SOFT_ACK.add(w.toLowerCase());
  for (const w of add.neutral ?? []) if (!YES_ONLY.has(w.toLowerCase())) REFUSE_FILL.add(w.toLowerCase());
  for (const w of add.noChangeNext ?? []) NO_CHANGE_NEXT.add(w.toLowerCase());
  REWRITES.push(...(add.rewrites ?? []));
  for (const w of add.questionOpeners ?? []) QUESTION_OPENERS.add(w.toLowerCase());
  for (const w of add.questionLeads ?? []) QUESTION_LEAD.add(w.toLowerCase());
  for (const w of add.cutOffs ?? []) CUT_OFF.add(w.toLowerCase());
  UNFINISHED_TAILS.push(...(add.unfinishedTails ?? []));
  QUESTION_EXCEPTIONS.push(...(add.questionExceptions ?? []));
  SKIP_PHRASES.push(...(add.skipPhrases ?? []));
}

const noChangeNextAlt = (): string => [...NO_CHANGE_NEXT].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/** A reply as plain words: lower-cased, apostrophes dropped, emoji yes / please read as words, hand-offs and negations rewritten into the tokens they mean. */
export function wordsOf(text: string): string[] {
  let s = text
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[\u{1F3FB}-\u{1F3FF}]|️/gu, "") // skin-tone modifiers and the emoji variation selector
    .replace(/[:;=]['-]?[(/|\\]|-_-|>_<|\bt_t\b|[✗✘✕]/gi, " emoji ")
    .replace(/\b(i|we|you|they|it|that)'ll\b/g, "$1 will")
    .replace(/\b(we|you|they)'re\b/g, "$1 are")
    .replace(/\b(?:i|we)'d\s+like\b|\b(?:i|we)\s+would\s+like\b|\bid\s+like\b/g, " i want ")
    .replace(/\b(it|that|there|here|everything|what)'s\b/g, "$1 is")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/[✓✔✅👍👌]/gu, " yes ")
    .replace(/🙏/gu, " please ")
    .replace(/\p{Extended_Pictographic}/gu, (m) => ("😊🙂😀😃😄😁👏💯🙌🤝❤😉😎🔥😂🥳🎉🆗😅🤗☺😇💪✌🫡🤩😍💙💚🧡☑".includes(m) ? " " : " emoji "))
    .replace(/'/g, "");
  for (const [re, to] of REWRITES) s = s.replace(re, to); // the register's phrases first — they map to the English tokens below
  s = s
    .replace(/\b100\s*(?:%|percent|per cent)/g, " absolutely ")
    .replace(/\bwell done\b|\b(?:good|nice|great) (?:work|job)\b/g, " praise ")
    .replace(/\b(?:no|nothing|zero)\s+(?:more\s+|further\s+)?(?:problems?|issues?|worr(?:y|ies)|doubts?|probs?|tension|concerns?|objections?)\b/g, " ok ")
    .replace(new RegExp("\\b(?:no|nothing|zero)\\s+(?:more\\s+|further\\s+)?(?:changes?|corrections?|edits?)(?:\\s+(?:needed|required|necessary))?\\b(?!\\s+(?:" + noChangeNextAlt() + ")\\b)", "g"), " ok ")
    .replace(/\b(?:no need|nothing)\s+to\s+(?:change|add|edit|correct|fix|update|worry)\b/g, " ok ")
    .replace(/\bnothing\s+(?:is\s+)?(?:wrong|incorrect)\b/g, " ok ")
    .replace(/\b(?:dont|do not|did not|never|not|isnt|is not|am not|arent)\s+(?:(?:want|wanna|going|gonna|like|need|wish|plan|have|ought)\s+)*(?:to\s+)?(?:(?:change|edit|redo|wrong|incorrect|wait|fix|update|revise|rectify|modify|alter|amend|adjust)\b|correct\s+(?:it|this|that|the|my|our)\b)/g, " ok ")
    .replace(/\b(?:dont|do not|never|not)\s+(?:keep|ok|okay|confirm|correct|right)\b/g, " incorrect ")
    .replace(/\b(?:fix|edit|update|revise|rectify)\s+(?:the|my|our|it|this|that|these|those|its)\b|\bcorrect\s+(?:the|my|our|it|this|that|these|those|its|everything|all|details|summary)\b(?!\s+(?:(?:price|rent|figure|amount|rate|value)\s+)?(?:is|are|was|were|looks?|seems?|sounds?|fine|ok|okay|right|good|perfect)\b)/g, " change ")
    .replace(/\b(?:let me|lemme|i will|ill|can you|can u|could you|kindly|please|pls)\s+(?:correct|fix|edit|update|revise)\b/g, " change ")
    .replace(/\bmake\s+(?:it|this|that|everything)\s+(?:right|correct|perfect|better)\b/g, " change ")
    .replace(/\b(?:let me|lemme|i will|ill|i shall|we will|shall i|shall we|i am going to|im going to|going to|will)\b(?!\s+(?:change|edit|redo)\b)/g, " later ")
    .replace(/\btoo\s+(?:high|low|much|less|more|expensive|costly|pricey|big|small|little)\b/g, " complaint ")
    .replace(/\bfor\s+(?:now|today)\b|\bas of now\b|\bnext\s+month\b/g, " later ")
    .replace(/\bha(?:\s+ha)+\b/g, " lol ")
    .replace(/\b(?:i am|im|we are|were|am)\s+done\b|\bdone\s+for\s+(?:now|today)\b|\bdone\s+with\s+(?:it|this|that)\b/g, " later ")
    .replace(/\blets?\s+go\s+(?:ahead|on)\b|\bgo\s+(?:ahead|on|for it)\b|\b(?:proceed|move)\s+ahead\b|\blets?\s+go\b(?!\s+of\b)|\bgo\s+with\s+(?:it|this|that)\b|\bnext\s+step\b/g, " proceed ")
    .replace(/\bmake\s+(?:it|this|that)\s+(?:go\s+)?live\b|\bgo\s+live\b/g, " proceed ")
    .replace(/\b(?:(?:looks?|sounds?|seems?|all)\s+)?(?:good|great|fine|perfect|ok|okay)\s+to\s+go\b|\b(?:looks?|sounds?|seems?|all)\s+(?:good|great|fine|perfect)\b/g, " ok ")
    .replace(/\b(?:i|we)\s+(?:may|might|could|would)\b|\b(?:may|might|could|would|should)\s+be\b|\bprobably\b|\bhopefully\b|\bpossibly\b|\b(?:i\s+)?(?:guess|suppose)\b|\bi\s+think\b/g, " maybe ")
    .replace(/\b(?:you|u)\s+(?:really\s+|very\s+)?sure\b/g, " doubt ")
    .replace(/\blet\s+(?:it|this|that)\s+go\b/g, " no ");
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The reply is a question or is not finished — never a bare yes or no. */
export function isQuestionShaped(text: string): boolean {
  const words = wordsOf(text);
  if (!words.length) return false;
  if (/\?/.test(text)) return true;
  if (CUT_OFF.has(words[words.length - 1]) && words.length > 1) return true;
  const n = words.length;
  if (UNFINISHED_TAILS.some(([a, b]) => words[n - 2] === a && words[n - 1] === b)) return true;
  let i = 0;
  while (i < n - 1 && QUESTION_LEAD.has(words[i])) i++;
  const first = words[i], second = words[i + 1];
  if (QUESTION_EXCEPTIONS.some((f) => f(first, second))) return false;
  if (QUESTION_OPENERS.has(first)) return true;
  if (/^(?:isnt|arent|doesnt|wasnt|werent|didnt|wouldnt|shouldnt)$/.test(first) && /^(?:it|this|that|we|you|they|there)$/.test(second ?? "")) return true;
  if (second === undefined || n - i < 3) return false;
  if (first === "do") return /^(?:you|u|i|we|they|there)$/.test(second);
  return /^(?:can|may|could|would|shall|have|has|am|will)$/.test(first) && /^(?:i|we|you|u|it|this|that|these|those|the|they|there|my|our)$/.test(second);
}

/**
 * The whole reply is a plain yes: confirm words, politeness and fillers (plus `extra` — the words
 * that are a yes in THIS question, e.g. "create", "submit" at the create gate), at least one
 * confirm word, no refusal word, nothing else. `opts.without`: words that are NOT neutral in this
 * question; `opts.anchors`: which of the `extra` count as a yes by themselves (default all);
 * `opts.strict`: acknowledgements and praise ("noted", "good work") do not count as a yes by themselves.
 */
export function isPlainYes(text: string, extra: Iterable<string> = [], opts: { without?: Set<string>; anchors?: Iterable<string>; strict?: boolean } = {}): boolean {
  const ok = new Set(extra);
  const anchors = opts.anchors ? new Set(opts.anchors) : ok;
  const words = wordsOf(text);
  const neutral = (x: string): boolean => NEUTRAL.has(x) && !opts.without?.has(x);
  const anchor = (x: string): boolean => (CONFIRM_WORDS.has(x) && !(opts.strict && SOFT_ACK.has(x))) || anchors.has(x);
  return words.length > 0 && !isQuestionShaped(text) && words.every((x) => neutral(x) || CONFIRM_WORDS.has(x) || YES_TAIL.has(x) || ok.has(x)) && words.some(anchor) && !words.some((x) => REFUSE_WORDS.has(x));
}

/** The nouns of a value question — neutral beside a yes ("price is right"), but a create gate refuses them. */
export const VALUE_NOUNS = new Set("price rent deposit amount figure asking rate number value".split(" "));

/** The reply is ONLY refusal words and fillers ("no", "nope not right", "change it") — no yes word, nothing else. */
export function isPlainNo(text: string): boolean {
  const words = wordsOf(text);
  return words.length > 0 && !isQuestionShaped(text) && words.some((x) => REFUSE_WORDS.has(x)) && words.every((x) => REFUSE_FILL.has(x) || REFUSE_WORDS.has(x) || REFUSE_NEUTRAL.has(x)) && !words.some((x) => ["yes", "keep", "ok", "okay", "sure"].includes(x));
}

/** Words of a skip ("skip", "skip this", "later", "not now") — the whole message. */
const SKIP_WORDS = new Set("skip pass later skipit none nothing".split(" "));
const SKIP_FILL = new Set("this that it for now step the please pls plz one these those all".split(" "));
export function isPlainSkip(text: string): boolean {
  if (SKIP_PHRASES.some((re) => re.test(text))) return true;
  const words = wordsOf(text);
  return words.length > 0 && !isQuestionShaped(text) && words.some((x) => SKIP_WORDS.has(x)) && words.every((x) => SKIP_WORDS.has(x) || SKIP_FILL.has(x) || NEUTRAL.has(x));
}
