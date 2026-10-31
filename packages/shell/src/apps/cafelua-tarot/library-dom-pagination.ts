export type MeasuredReaderPage = {
  chapterIndex: number;
  chapterTitle: string;
  pageInChapter: number;
  html: string;
  usedHeight: number;
  availableHeight: number;
  /** 펼침면 정렬을 위해 넣은 빈 쪽 */
  blank?: boolean;
};

/**
 * 두 쪽 펼침에서 각 장이 펼침을 온전히 채우도록, 장의 쪽 수가 홀수면 장 끝에
 * 빈 쪽을 더해 짝수(펼침 단위)로 맞춘다. 이렇게 하면 넘쳐서 반 펼침만 찬 장의
 * 빈 자리가 빈 쪽으로 채워지고, 다음 장은 늘 펼침의 왼쪽 쪽에서 시작한다.
 * 한 쪽 보기(step 1)에서는 그대로 둔다.
 */
export function alignChapterStartsToSpreads(
  pages: MeasuredReaderPage[],
  step: number,
): MeasuredReaderPage[] {
  if (step < 2) return pages;
  const aligned: MeasuredReaderPage[] = [];
  let index = 0;
  while (index < pages.length) {
    const chapterIndex = pages[index].chapterIndex;
    const group: MeasuredReaderPage[] = [];
    while (index < pages.length && pages[index].chapterIndex === chapterIndex) {
      group.push(pages[index]);
      index += 1;
    }
    group.forEach((page) => aligned.push(page));
    const remainder = group.length % step;
    if (remainder !== 0) {
      const last = group[group.length - 1];
      for (let pad = 0; pad < step - remainder; pad += 1) {
        aligned.push({
          chapterIndex: last.chapterIndex,
          chapterTitle: last.chapterTitle,
          pageInChapter: last.pageInChapter + 1 + pad,
          html: "",
          usedHeight: 0,
          availableHeight: last.availableHeight,
          blank: true,
        });
      }
    }
  }
  return aligned;
}

const FIT_TOLERANCE_PX = 1;

function fits(content: HTMLElement) {
  return content.scrollHeight <= content.clientHeight + FIT_TOLERANCE_PX;
}

function textBoundary(root: Element, absoluteOffset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = absoluteOffset;
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  return null;
}

function fragmentBetween(root: Element, start: number, end: number) {
  const startBoundary = textBoundary(root, start);
  const endBoundary = textBoundary(root, end);
  if (!startBoundary || !endBoundary) return null;
  const range = document.createRange();
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  const shell = root.cloneNode(false) as Element;
  shell.append(range.cloneContents());
  return shell;
}

function measuredSplit(
  source: Element,
  content: HTMLElement,
): { head: Element; tail: Element | null } | null {
  const text = source.textContent ?? "";
  if (text.length < 2) return null;

  // 앞쪽 공백까지만 자르면 빈 인용 상자 같은 껍데기만 앞 쪽에 남으므로, 첫 글자가 들어가는 곳부터 자른다.
  const firstVisible = text.search(/\S/u);
  if (firstVisible < 0) return null;
  const boundaries = [0];
  for (const match of text.matchAll(/\s+/gu)) {
    const boundary = match.index + match[0].length;
    if (boundary > firstVisible) boundaries.push(boundary);
  }
  if (boundaries.at(-1) !== text.length) boundaries.push(text.length);

  let low = 1;
  let high = boundaries.length - 1;
  let best = 0;
  let candidate: Element | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    candidate?.remove();
    candidate = fragmentBetween(source, 0, boundaries[middle]);
    if (!candidate) break;
    content.append(candidate);
    if (fits(content)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  candidate?.remove();
  if (best === 0) return null;
  const cut = boundaries[best];
  return {
    head: fragmentBetween(source, 0, cut)!,
    tail: cut < text.length ? fragmentBetween(source, cut, text.length) : null,
  };
}

function emptyTableClone(table: HTMLTableElement) {
  const clone = table.cloneNode(true) as HTMLTableElement;
  clone.querySelectorAll("tbody").forEach((body) => body.replaceChildren());
  return clone;
}

function shrinkTableToFit(table: HTMLTableElement, content: HTMLElement) {
  let scale = 0.95;
  while (!fits(content) && scale >= 0.5) {
    table.style.fontSize = `${scale}em`;
    scale -= 0.05;
  }
}

// 그림이 쪽에 다 안 들어가면 가로 폭을 줄여(세로도 비율대로 줄어든다) 한 쪽에 담는다.
// 제목 바로 밑 그림이 제목과 갈라져 다음 쪽으로 넘어가는 것을 막는 데 쓴다.
function shrinkImageToFit(block: Element, content: HTMLElement) {
  const img = block.querySelector("img");
  if (!img) return;
  let scale = 0.95;
  while (!fits(content) && scale >= 0.4) {
    img.style.maxWidth = `${Math.round(scale * 100)}%`;
    img.style.height = "auto";
    scale -= 0.05;
  }
}

export function measureRenderedReaderPages(
  sourceRoot: HTMLElement,
  templatePage: HTMLElement,
): MeasuredReaderPage[] {
  const templateBounds = templatePage.getBoundingClientRect();
  if (templateBounds.width < 1 || templateBounds.height < 1) return [];

  const probe = templatePage.cloneNode(true) as HTMLElement;
  probe.removeAttribute("data-measure-template");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "fixed";
  probe.style.left = "-10000px";
  probe.style.top = "0";
  probe.style.width = `${templateBounds.width}px`;
  probe.style.height = `${templateBounds.height}px`;
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.setProperty(
    "--reader-font-scale",
    getComputedStyle(templatePage).getPropertyValue("--reader-font-scale") || "1",
  );
  document.body.append(probe);

  const content = probe.querySelector<HTMLElement>(".library-paper-content");
  if (!content) {
    probe.remove();
    return [];
  }
  content.replaceChildren();

  const pages: MeasuredReaderPage[] = [];
  let chapterIndex = 0;
  let chapterTitle = "";
  let pageInChapter = 0;

  const flush = () => {
    if (!content.childNodes.length) return;
    pages.push({
      chapterIndex,
      chapterTitle,
      pageInChapter: pageInChapter++,
      html: content.innerHTML,
      usedHeight: content.scrollHeight,
      availableHeight: content.clientHeight,
    });
    content.replaceChildren();
  };

  const isHeading = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLElement && /^H[1-6]$/.test(el.tagName);
  // 쪽 끝에 제목만 남는 것을 막는다. 쪽의 끝이 제목(들)뿐이면 떼어서 다음
  // 블록과 같은 쪽으로 옮긴다. 장은 `# 제목` 다음에 그림이 오므로, 이렇게 하면
  // 제목과 그림이 갈라져 다음 쪽으로 넘어가지 않는다.
  const detachTrailingHeadings = (): Element[] => {
    const carried: Element[] = [];
    while (isHeading(content.lastElementChild)) {
      const heading = content.lastElementChild as Element;
      heading.remove();
      carried.unshift(heading);
    }
    return carried;
  };

  const appendBlock = (sourceBlock: Element) => {
    let block: Element | null = sourceBlock.cloneNode(true) as Element;
    let carriedHeadings = false;
    while (block) {
      content.append(block);
      if (fits(content)) return;
      block.remove();
      // 제목을 뒤 블록과 같은 쪽에 붙인다. 한 번만 옮겨 무한 반복을 막는다.
      if (!carriedHeadings && content.childNodes.length) {
        const carried = detachTrailingHeadings();
        if (carried.length) {
          if (content.childNodes.length) flush();
          carried.forEach((heading) => content.append(heading));
          carriedHeadings = true;
          continue;
        }
      }
      // 그림이 든 덩어리는 글자 단위로 자르면 그림이 빠지므로 통째로 둔다.
      if (block.querySelector("img")) {
        // 제목이 이 그림과 함께 넘어온 경우: 제목만 남은 쪽을 비워내 갈라놓지 말고,
        // 그림을 줄여서라도 제목 바로 밑에 붙여 같은 쪽에 담는다.
        if (carriedHeadings) {
          content.append(block);
          shrinkImageToFit(block, content);
          flush();
          return;
        }
        if (content.childNodes.length) {
          flush();
          continue;
        }
        content.replaceChildren(block);
        shrinkImageToFit(block, content);
        flush();
        return;
      }
      if (content.childNodes.length) {
        const split = measuredSplit(block, content);
        if (split) {
          content.append(split.head);
          flush();
          block = split.tail;
          continue;
        }
        flush();
        continue;
      }

      const split = measuredSplit(block, content);
      if (!split) {
        content.replaceChildren(block);
        flush();
        return;
      }
      content.append(split.head);
      flush();
      block = split.tail;
    }
  };

  const appendTable = (sourceTable: HTMLTableElement) => {
    const wholeTable = sourceTable.cloneNode(true) as HTMLTableElement;
    content.append(wholeTable);
    if (fits(content)) return;
    wholeTable.remove();
    if (content.childNodes.length) flush();

    const sourceBodies = Array.from(sourceTable.tBodies);
    const rows = sourceBodies.flatMap((body, bodyIndex) =>
      Array.from(body.rows).map((row) => ({ row, bodyIndex })),
    );
    let fragment = emptyTableClone(sourceTable);
    content.append(fragment);

    for (const { row, bodyIndex } of rows) {
      const targetBody = fragment.tBodies[bodyIndex] ?? fragment.createTBody();
      const rowClone = row.cloneNode(true) as HTMLTableRowElement;
      targetBody.append(rowClone);
      if (fits(content)) continue;

      rowClone.remove();
      const hasRows = Array.from(fragment.tBodies).some((body) => body.rows.length > 0);
      if (hasRows) {
        flush();
        fragment = emptyTableClone(sourceTable);
        content.append(fragment);
        (fragment.tBodies[bodyIndex] ?? fragment.createTBody()).append(rowClone);
        shrinkTableToFit(fragment, content);
      } else {
        // A single unusually tall row is still measured, then reduced only as far as
        // needed. Normal rows never enter this fallback.
        targetBody.append(rowClone);
        shrinkTableToFit(fragment, content);
      }
    }
  };

  for (const chapter of sourceRoot.querySelectorAll<HTMLElement>("[data-reader-chapter]")) {
    flush();
    chapterIndex = Number(chapter.dataset.chapterIndex ?? 0);
    chapterTitle = chapter.dataset.chapterTitle ?? "";
    pageInChapter = 0;
    // 한 장에 여러 편이 들어가는 책은 소제목에서 쪽을 새로 시작한다. 시 한 편이
    // 앞 편의 꼬리에 붙어 시작하면 어디서 끝나고 어디서 시작하는지 읽히지 않는다.
    const breakOn = chapter.dataset.pageBreakOn;
    for (const child of Array.from(chapter.children)) {
      if (breakOn === "h2" && child.tagName === "H2" && content.childNodes.length) flush();
      if (child instanceof HTMLTableElement) appendTable(child);
      else appendBlock(child);
    }
    flush();
  }

  probe.remove();
  return pages;
}
