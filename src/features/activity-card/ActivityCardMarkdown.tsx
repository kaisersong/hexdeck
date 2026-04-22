import type { ReactElement, ReactNode } from 'react';

function sanitizeHref(href: string): string | null {
  const normalizedHref = href.trim();

  if (!normalizedHref) {
    return null;
  }

  if (
    /^https?:\/\//i.test(normalizedHref) ||
    /^mailto:/i.test(normalizedHref) ||
    normalizedHref.startsWith('/') ||
    normalizedHref.startsWith('#')
  ) {
    return normalizedHref;
  }

  return null;
}

function renderInline(text: string, keyPrefix: string): Array<ReactElement | string> {
  const nodes: Array<ReactElement | string> = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  let tokenIndex = 0;

  while (match) {
    const [fullMatch, linkLabel, linkHref, strongText, codeText, italicAsteriskText, italicUnderscoreText] = match;
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (linkLabel && linkHref) {
      const safeHref = sanitizeHref(linkHref);
      if (safeHref) {
        nodes.push(
          <a
            key={`${keyPrefix}-link-${tokenIndex}`}
            className="floating-card__markdown-link"
            href={safeHref}
            rel="noreferrer"
            target="_blank"
          >
            {renderInline(linkLabel, `${keyPrefix}-link-label-${tokenIndex}`)}
          </a>
        );
      } else {
        nodes.push(fullMatch);
      }
    } else if (strongText) {
      nodes.push(
        <strong key={`${keyPrefix}-strong-${tokenIndex}`}>
          {renderInline(strongText, `${keyPrefix}-strong-text-${tokenIndex}`)}
        </strong>
      );
    } else if (codeText) {
      nodes.push(
        <code key={`${keyPrefix}-code-${tokenIndex}`} className="floating-card__markdown-inline-code">
          {codeText}
        </code>
      );
    } else {
      const emphasisText = italicAsteriskText ?? italicUnderscoreText;
      if (emphasisText) {
        nodes.push(
          <em key={`${keyPrefix}-em-${tokenIndex}`}>
            {renderInline(emphasisText, `${keyPrefix}-em-text-${tokenIndex}`)}
          </em>
        );
      } else {
        nodes.push(fullMatch);
      }
    }

    lastIndex = match.index + fullMatch.length;
    tokenIndex += 1;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderInlineWithBreaks(text: string, keyPrefix: string): Array<ReactElement | string> {
  const lines = text.split('\n');
  const nodes: Array<ReactElement | string> = [];

  lines.forEach((line, index) => {
    if (index > 0) {
      nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
    }
    nodes.push(...renderInline(line, `${keyPrefix}-line-${index}`));
  });

  return nodes;
}

function isFenceStart(line: string): boolean {
  return /^```[\w-]*\s*$/.test(line.trim());
}

function isUnorderedListItem(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function isOrderedListItem(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function isBlockquoteLine(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function isBlockBoundary(line: string): boolean {
  return isFenceStart(line) || isUnorderedListItem(line) || isOrderedListItem(line) || isBlockquoteLine(line);
}

function renderMarkdownBlocks(markdown: string, keyPrefix: string): ReactNode[] {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, '\n').trim();
  if (!normalizedMarkdown) {
    return [];
  }

  const lines = normalizedMarkdown.split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      index += 1;
      continue;
    }

    if (isFenceStart(trimmedLine)) {
      const language = trimmedLine.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !isFenceStart(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length && isFenceStart(lines[index].trim())) {
        index += 1;
      }

      const code = codeLines.join('\n');
      blocks.push(
        <pre key={`${keyPrefix}-code-${blocks.length}`} className="floating-card__markdown-code-block">
          <code
            className={language ? `floating-card__markdown-code language-${language}` : 'floating-card__markdown-code'}
          >
            {code}
          </code>
        </pre>
      );
      continue;
    }

    if (isUnorderedListItem(line)) {
      const items: string[] = [];
      while (index < lines.length && isUnorderedListItem(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, '').trim());
        index += 1;
      }

      blocks.push(
        <ul key={`${keyPrefix}-ul-${blocks.length}`} className="floating-card__markdown-list">
          {items.map((item, itemIndex) => (
            <li key={`${keyPrefix}-ul-item-${blocks.length}-${itemIndex}`}>
              {renderInlineWithBreaks(item, `${keyPrefix}-ul-inline-${blocks.length}-${itemIndex}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (isOrderedListItem(line)) {
      const items: string[] = [];
      while (index < lines.length && isOrderedListItem(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, '').trim());
        index += 1;
      }

      blocks.push(
        <ol key={`${keyPrefix}-ol-${blocks.length}`} className="floating-card__markdown-list">
          {items.map((item, itemIndex) => (
            <li key={`${keyPrefix}-ol-item-${blocks.length}-${itemIndex}`}>
              {renderInlineWithBreaks(item, `${keyPrefix}-ol-inline-${blocks.length}-${itemIndex}`)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    if (isBlockquoteLine(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && isBlockquoteLine(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }

      blocks.push(
        <blockquote key={`${keyPrefix}-quote-${blocks.length}`} className="floating-card__markdown-quote">
          {renderMarkdownBlocks(quoteLines.join('\n'), `${keyPrefix}-quote-nested-${blocks.length}`)}
        </blockquote>
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const currentLine = lines[index];
      if (!currentLine.trim()) {
        break;
      }
      if (paragraphLines.length > 0 && isBlockBoundary(currentLine)) {
        break;
      }
      paragraphLines.push(currentLine);
      index += 1;
    }

    blocks.push(
      <p key={`${keyPrefix}-p-${blocks.length}`}>
        {renderInlineWithBreaks(paragraphLines.join('\n'), `${keyPrefix}-p-inline-${blocks.length}`)}
      </p>
    );
  }

  return blocks;
}

export function ActivityCardMarkdown({
  className,
  markdown,
}: {
  className: string;
  markdown: string;
}) {
  return <div className={`${className} floating-card__markdown`}>{renderMarkdownBlocks(markdown, className)}</div>;
}
