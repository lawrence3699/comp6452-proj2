/**
 * Error translation — owner: person 4.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Showing access control being enforced is part of the demo: a transporter
 * tries to register a batch, and the network refuses. That is the moment the
 * ABAC design pays off, so it has to read as a sentence. Left alone, the
 * gateway raises an `EndorseError` whose `message` is a gRPC status line
 * ("10 ABORTED: failed to endorse transaction ..., see attached details for
 * more info") and buries the chaincode's actual complaint in
 * `details[].message`. Printing that raw turns the highlight of the demo into
 * a wall of noise that looks like a crash.
 *
 * So: pull the chaincode's own message out of the gRPC details, and recognise
 * the ones the marking criteria care about well enough to say what happened in
 * domain terms. The chaincode message is always printed too — the friendly
 * line is a gloss on the evidence, never a replacement for it.
 *
 * Pure functions over a structural type, so the whole thing is unit tested
 * without a network or a real GatewayError.
 */

/** Structural view of `GatewayError` — matched by shape, not by instanceof. */
export interface GatewayErrorLike {
  readonly message?: string;
  readonly code?: number;
  readonly details?: ReadonlyArray<{ readonly message?: string; readonly mspId?: string }>;
}

/**
 * `instanceof GatewayError` is unreliable here: the error may cross a module
 * boundary where two copies of the SDK are loaded (the clients resolve it
 * through a `file:` dependency), and a duplicate class identity would make the
 * check silently false. Structural matching cannot fail that way.
 */
const isGatewayErrorLike = (error: unknown): error is GatewayErrorLike =>
  typeof error === 'object' && error !== null && 'details' in error;

/**
 * The chaincode's own error text.
 *
 * Endorsing peers each report separately and, for a deterministic rejection,
 * identically — so the distinct messages are joined rather than the first one
 * taken, which keeps a genuine disagreement between peers visible instead of
 * hidden behind whichever peer answered first.
 */
export const chaincodeMessage = (error: unknown): string | undefined => {
  if (!isGatewayErrorLike(error)) {
    return undefined;
  }
  const messages = (error.details ?? [])
    .map((detail) => detail.message)
    .filter((message): message is string => typeof message === 'string' && message !== '');
  if (messages.length === 0) {
    return undefined;
  }
  return [...new Set(messages)].join('; ');
};

/** Best available text for an unknown thrown value. */
export const rawMessage = (error: unknown): string => {
  const fromChaincode = chaincodeMessage(error);
  if (fromChaincode !== undefined) {
    return fromChaincode;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (isGatewayErrorLike(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
};

/** Domain-level explanation for a message, or undefined when we have no gloss. */
export interface Explanation {
  /** Sentence a marker can read without knowing the codebase. */
  readonly headline: string;
  /** Why the network behaved this way — the design point being demonstrated. */
  readonly because?: string;
}

/**
 * Recognise the rejections the demo deliberately provokes.
 *
 * Matching on message text is a deliberate trade: the chaincode does not
 * return structured error codes (the brief freezes it as `throw new Error`
 * with a descriptive message, and the tests assert on those strings), so text
 * is the only signal available. Every pattern below is anchored to a message
 * that a chaincode unit test also pins, and an unrecognised message falls
 * through to the raw text rather than being mislabelled.
 */
export const explain = (message: string, context: string): Explanation | undefined => {
  const lower = message.toLowerCase();

  const roleMatch = /caller has role '([^']+)', '([^']+)' is required/.exec(message);
  if (roleMatch) {
    const [, actual, required] = roleMatch;
    return {
      headline: `a ${actual} cannot ${context} — only a ${required} may`,
      because:
        `the role travels as a signed ABAC attribute on the caller's enrolment ` +
        `certificate, so the peer checked it before endorsing`,
    };
  }

  if (lower.includes("carries no 'role' attribute")) {
    return {
      headline: `this identity cannot ${context} — its certificate carries no role at all`,
      because: 'roles are issued by Fabric CA at enrolment; an unenrolled identity has none',
    };
  }

  if (lower.includes('only an identity enrolled with the oracle attribute')) {
    return {
      headline: 'only the oracle identity may submit temperature readings',
      because: "the oracle attribute is baked into the certificate ('oracle=true:ecert')",
    };
  }

  if (lower.includes('is not a regulator')) {
    return {
      headline: `this identity cannot ${context} — that is a regulator-only action`,
    };
  }

  if (lower.includes('must be a regulator')) {
    return {
      headline: `this identity cannot ${context} — only a regulator, or the oracle acting ` +
        'through coldchain-compliance, may',
    };
  }

  const holderMatch = /caller (\S+) is not the current holder (\S+)/.exec(message);
  if (holderMatch) {
    const [, caller, holder] = holderMatch;
    return {
      headline: `${caller} cannot hand on this batch — ${holder} is holding it`,
      because: 'custody can only be transferred by whoever currently has the goods',
    };
  }

  const transitionMatch = /illegal status transition: (\S+) -> (\S+)/.exec(message);
  if (transitionMatch) {
    const [, from, to] = transitionMatch;
    return {
      headline: `a batch that is ${from} cannot become ${to}`,
      because: 'the batch lifecycle is a state machine enforced on chain',
    };
  }

  if (/batch \S+ already exists/.test(message)) {
    return {
      headline: 'that batch id is already on the ledger — ids are registered once and only once',
    };
  }

  if (/batch \S+ does not exist/.test(message) || lower.includes('not found in batch-registry')) {
    return {
      headline: 'no batch with that id exists on the ledger',
    };
  }

  if (lower.includes('no private details readable')) {
    return {
      headline: 'the private details are not readable by this organisation',
      because:
        'private data is gossiped only to members of the batchPrivateDetails collection',
    };
  }

  return undefined;
};

/**
 * Render a failure for the console.
 *
 * `context` is what the user was trying to do, phrased as a verb clause
 * ("register a batch"), so the headline reads as a sentence.
 */
export const describeFailure = (error: unknown, context: string): string => {
  const message = rawMessage(error);
  const explanation = explain(message, context);

  if (explanation === undefined) {
    return `  FAILED to ${context}\n    ${message}`;
  }

  const lines = [
    `  REJECTED BY THE NETWORK: ${explanation.headline}`,
    `    chaincode said: ${message}`,
  ];
  if (explanation.because !== undefined) {
    lines.push(`    why: ${explanation.because}`);
  }
  return lines.join('\n');
};

/**
 * True when the failure was the network enforcing a rule, rather than a bug or
 * an unreachable peer. The demo expects some of these, so it needs to tell
 * "the access control worked" apart from "the demo broke".
 */
export const isPolicyRejection = (error: unknown): boolean =>
  explain(rawMessage(error), 'act') !== undefined;
