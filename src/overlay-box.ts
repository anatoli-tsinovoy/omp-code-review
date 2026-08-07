import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

/** Pad or truncate ANSI-styled text to exactly `width` columns. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const measured = visibleWidth(text);
  if (measured === width) return text;
  if (measured < width) return text + padding(width - measured);
  const truncated = truncateToWidth(text, width);
  const truncatedWidth = visibleWidth(truncated);
  return truncatedWidth < width
    ? truncated + padding(width - truncatedWidth)
    : truncated;
}

function paint(theme: Theme, text: string): string {
  return theme.fg("border", text);
}

export function topBorder(theme: Theme, width: number, title: string): string {
  const box = theme.boxRound;
  const innerWidth = Math.max(0, width - 2);
  if (!title)
    return paint(
      theme,
      box.topLeft + box.horizontal.repeat(innerWidth) + box.topRight,
    );
  const shown = truncateToWidth(` ${title} `, Math.max(0, innerWidth - 2));
  const fillWidth = Math.max(0, innerWidth - 1 - visibleWidth(shown));
  return (
    paint(theme, box.topLeft + box.horizontal) +
    theme.bold(theme.fg("accent", shown)) +
    paint(theme, box.horizontal.repeat(fillWidth) + box.topRight)
  );
}

export function divider(theme: Theme, width: number): string {
  const box = theme.boxRound;
  return paint(
    theme,
    box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft,
  );
}

export function bottomBorder(theme: Theme, width: number): string {
  const box = theme.boxRound;
  return paint(
    theme,
    box.bottomLeft +
      box.horizontal.repeat(Math.max(0, width - 2)) +
      box.bottomRight,
  );
}

export function row(theme: Theme, content: string, width: number): string {
  const box = theme.boxRound;
  return `${paint(theme, box.vertical)} ${fit(content, Math.max(0, width - 4))} ${paint(theme, box.vertical)}`;
}

function splitDividerColumn(sidebarWidth: number): number {
  return sidebarWidth + 3;
}

export function splitBodyWidth(width: number, sidebarWidth: number): number {
  return Math.max(0, width - sidebarWidth - 7);
}

export function topBorderSplit(
  theme: Theme,
  width: number,
  title: string,
  sidebarWidth: number,
): string {
  const box = theme.boxRound;
  const dividerColumn = splitDividerColumn(sidebarWidth);
  const leftLength = Math.max(0, dividerColumn - 1);
  const rightLength = Math.max(0, width - 2 - dividerColumn);
  let left: string;
  if (!title) {
    left = paint(theme, box.topLeft + box.horizontal.repeat(leftLength));
  } else {
    const shown = truncateToWidth(` ${title} `, Math.max(0, leftLength - 1));
    const fillWidth = Math.max(0, leftLength - 1 - visibleWidth(shown));
    left =
      paint(theme, box.topLeft + box.horizontal) +
      theme.bold(theme.fg("accent", shown)) +
      paint(theme, box.horizontal.repeat(fillWidth));
  }
  return (
    left +
    paint(
      theme,
      box.teeDown + box.horizontal.repeat(rightLength) + box.topRight,
    )
  );
}

export function dividerSplit(
  theme: Theme,
  width: number,
  sidebarWidth: number,
): string {
  const box = theme.boxRound;
  const dividerColumn = splitDividerColumn(sidebarWidth);
  const leftLength = Math.max(0, dividerColumn - 1);
  const rightLength = Math.max(0, width - 2 - dividerColumn);
  return paint(
    theme,
    box.teeRight +
      box.horizontal.repeat(leftLength) +
      box.teeUp +
      box.horizontal.repeat(rightLength) +
      box.teeLeft,
  );
}

export function splitRow(
  theme: Theme,
  sidebar: string,
  body: string,
  width: number,
  sidebarWidth: number,
): string {
  const box = theme.boxRound;
  const bodyWidth = splitBodyWidth(width, sidebarWidth);
  const bar = paint(theme, box.vertical);
  return `${bar} ${fit(sidebar, sidebarWidth)} ${bar} ${fit(body, bodyWidth)} ${bar}`;
}
