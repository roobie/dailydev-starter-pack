// Visitor Plus PAT — the single highest-risk value in this app.
//
// PAT-in-transit hygiene requires runtime teeth, not just type-system fiction.
// A branded `string & { brand: true }` looks safe but is still a string
// primitive at runtime, so toString/toJSON/template-interp can leak the
// value. This implementation uses a class with a private field, so the only
// paths to the raw string are toJSON (returns [REDACTED]), toString (returns
// [REDACTED]), Symbol.toPrimitive (returns [REDACTED]), and the explicit
// `.unsafeValue()` method.
//
// Greppable: every dereference of the underlying string is a `.unsafeValue()`
// call site, auditable with a single grep.

const PAT_SHAPE = /^[A-Za-z0-9_-]{20,}$/;

export class Pat {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  // The only constructor surface. Validates shape before branding.
  static from(s: unknown): Pat {
    if (typeof s !== "string") {
      throw new Error("pat: not a string");
    }
    if (!PAT_SHAPE.test(s)) {
      throw new Error("pat: shape rejected");
    }
    return new Pat(s);
  }

  // Extraction. Call sites must be auditable. The only legitimate caller is
  // src/dailydev.ts at the point of building the Authorization header.
  unsafeValue(): string {
    return this.#value;
  }

  // Defensive overrides — any accidental coercion returns the redacted marker.
  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }

  [Symbol.toPrimitive](_hint: string): string {
    return "[REDACTED]";
  }
}
