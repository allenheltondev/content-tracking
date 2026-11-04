// The API's largest page, so walking a whole list takes as few calls as possible.
export const MAX_PAGE_SIZE = 500;

// Walks a cursor-paginated list to the end. For screens that need every row to
// be correct (a calendar, a client-side search, a count). Lists people browse
// should use useInfiniteQuery and a Load more button instead.
export async function fetchAllPages<Page extends { nextStartKey?: string | null }>(
  fetchPage: (startKey: string | undefined) => Promise<Page>,
): Promise<Page[]> {
  const pages: Page[] = [];
  let startKey: string | undefined;
  do {
    const page = await fetchPage(startKey);
    pages.push(page);
    startKey = page.nextStartKey ?? undefined;
  } while (startKey);
  return pages;
}
