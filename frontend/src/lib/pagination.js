export const DEFAULT_PAGE_SIZE = 12;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function timestamp(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function compareIdsNewestFirst(leftId, rightId) {
  const left = `${leftId ?? ''}`;
  const right = `${rightId ?? ''}`;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const normalizedLeft = left.replace(/^0+(?=\d)/, '');
    const normalizedRight = right.replace(/^0+(?=\d)/, '');
    if (normalizedLeft.length !== normalizedRight.length) return normalizedRight.length - normalizedLeft.length;
    const comparison = normalizedRight.localeCompare(normalizedLeft);
    if (comparison) return comparison;
  }
  return right.localeCompare(left);
}

export function newestFirst(items, dateKey = 'insertedAt') {
  const collection = Array.isArray(items) ? items : [];
  return collection
    .map((item, index) => ({ item, index, createdAt: timestamp(item?.[dateKey]) }))
    .sort((left, right) => {
      if (left.createdAt !== null || right.createdAt !== null) {
        if (left.createdAt === null) return 1;
        if (right.createdAt === null) return -1;
        if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
      }
      return compareIdsNewestFirst(left.item?.id, right.item?.id) || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function paginate(items, requestedPage = 1, requestedPageSize = DEFAULT_PAGE_SIZE) {
  const collection = Array.isArray(items) ? items : [];
  const pageSize = positiveInteger(requestedPageSize, DEFAULT_PAGE_SIZE);
  const totalItems = collection.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(positiveInteger(requestedPage, 1), totalPages);
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  return {
    pageItems: collection.slice(startIndex, endIndex),
    page,
    pageSize,
    totalItems,
    totalPages,
    startIndex,
    endIndex,
  };
}

export function paginationTokens(page, totalPages, maximum = 7) {
  const last = positiveInteger(totalPages, 1);
  const current = Math.min(positiveInteger(page, 1), last);
  const limit = Math.max(5, positiveInteger(maximum, 7));

  if (last <= limit) return Array.from({ length: last }, (_, index) => index + 1);

  const pages = new Set([1, last, current - 1, current, current + 1]);
  if (current <= 4) [2, 3, 4, 5].forEach((value) => pages.add(value));
  if (current >= last - 3) [last - 4, last - 3, last - 2, last - 1].forEach((value) => pages.add(value));

  const sorted = [...pages].filter((value) => value >= 1 && value <= last).sort((left, right) => left - right);
  const tokens = [];
  for (const value of sorted) {
    const previous = tokens[tokens.length - 1];
    if (typeof previous === 'number' && value - previous > 1) tokens.push(`ellipsis-${previous}-${value}`);
    tokens.push(value);
  }
  return tokens;
}
