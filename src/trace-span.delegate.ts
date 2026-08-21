export class TraceSpanDelegate {
  get id(): string {
    return this._id;
  }

  get name(): string | undefined {
    return this._name;
  }

  constructor(
    private readonly _id: string,
    private readonly _name: string | undefined,
    private readonly _tags: Record<string, string | number | boolean>,
  ) {}

  /**
   * Sets a tag on the trace span.
   * @param key - The key for the tag.
   * @param value - The value for the tag. This can be a string, number, or boolean.
   * @returns The current instance of the TraceSpanDelegate for method chaining.
   */
  setTag(key: string, value: string | number | boolean): TraceSpanDelegate {
    this._tags[key] = value;
    return this;
  }

  /**
   * Adds multiple tags to the trace span.
   * @param tags - An object containing key-value pairs for the tags.
   * @returns The current instance of the TraceSpanDelegate for method chaining.
   */
  addTags(tags: Record<string, string | number | boolean>): TraceSpanDelegate {
    Object.assign(this._tags, tags);
    return this;
  }
}
