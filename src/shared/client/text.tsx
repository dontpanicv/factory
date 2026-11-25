import type { VNode } from "preact";

/** Text as a page shows it: links, and the Markdown that agents write. */

/** A URL in text, without the punctuation that ends its sentence. */
const URL_TEXT = /https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g;

/** Text with its URLs as links. Preact escapes the rest. */
export const Linked = (props: { readonly text: string }) => {
  const parts: (string | VNode)[] = [];
  let from = 0;
  for (const match of props.text.matchAll(URL_TEXT)) {
    const [url] = match;
    parts.push(props.text.slice(from, match.index));
    parts.push(
      <a href={url} key={match.index} rel="noopener" target="_blank">
        {url}
      </a>
    );
    from = match.index + url.length;
  }
  parts.push(props.text.slice(from));
  return <>{parts}</>;
};

const FENCE = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
const MARKED = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/;
const LINK = /^\[([^\]]+)\]\((.+)\)$/;
const HEADING = /^#{1,6}\s+(.+)$/;
const ITEM = /^\s*([-*]|\d+[.)])\s+(.+)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** One marked part of a line: `code`, **strong**, or a [link](url). */
const Marked = (props: { readonly part: string }) => {
  const { part } = props;
  if (part.startsWith("`")) {
    return <code>{part.slice(1, -1)}</code>;
  }
  if (part.startsWith("**")) {
    return <strong>{part.slice(2, -2)}</strong>;
  }
  const [, text = part, href = ""] = part.match(LINK) ?? [];
  return (
    <a href={href} rel="noopener" target="_blank">
      {text}
    </a>
  );
};

/** A line of text with `code`, **strong** words and [links](url), and its bare URLs as links. */
export const Inline = (props: { readonly text: string }) => {
  let at = 0;
  return (
    <>
      {props.text.split(MARKED).map((part) => {
        const key = at;
        at += part.length;
        return MARKED.test(part) && part.length > 2 ? (
          <Marked key={key} part={part} />
        ) : (
          <Linked key={key} text={part} />
        );
      })}
    </>
  );
};

/** Text without code blocks: a heading, the items of a list and the rows of a table show as such. */
const Prose = (props: { readonly text: string }) => {
  const out: (VNode | string)[] = [];
  const lines = props.text.split("\n");
  let table: string[] = [];
  let at = 0;
  const endTable = () => {
    if (table.length > 0) {
      out.push(
        <pre class="message__code" key={`table-${at}`}>
          {table.join("\n")}
        </pre>
      );
      table = [];
    }
  };
  for (const line of lines) {
    at += line.length + 1;
    if (TABLE_ROW.test(line)) {
      table.push(line.trim());
      continue;
    }
    endTable();
    const [, mark = "", item = ""] = line.match(ITEM) ?? [];
    const [, heading = ""] = line.match(HEADING) ?? [];
    // A list with numbers keeps its numbers.
    const bullet = mark.length === 1 ? "•" : mark;
    if (item !== "") {
      out.push(
        <span class="message__item" key={at}>
          <span class="message__mark">{bullet}</span>
          <Inline text={item} />
        </span>
      );
    } else if (heading === "") {
      out.push(<Inline key={at} text={line} />, "\n");
    } else {
      out.push(
        <strong class="message__heading" key={at}>
          <Inline text={heading} />
        </strong>,
        "\n"
      );
    }
  }
  endTable();
  // The last line has no line break after it.
  if (out.at(-1) === "\n") {
    out.pop();
  }
  return <>{out}</>;
};

/**
 * The text of a message. Agents write Markdown, so code, strong words, links, headings, lists and
 * tables show as such. All other text shows as it was written.
 */
export const Rich = (props: { readonly text: string }) => {
  const blocks: VNode[] = [];
  let from = 0;
  for (const match of props.text.matchAll(FENCE)) {
    const before = props.text.slice(from, match.index).trim();
    if (before !== "") {
      blocks.push(<Prose key={`text-${from}`} text={before} />);
    }
    blocks.push(
      <pre class="message__code" key={`code-${match.index}`}>
        {(match[1] ?? "").trimEnd()}
      </pre>
    );
    from = match.index + match[0].length;
  }
  const rest = props.text.slice(from).trim();
  if (rest !== "") {
    blocks.push(<Prose key={`text-${from}`} text={rest} />);
  }
  return <>{blocks}</>;
};
