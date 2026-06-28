import type { ApiFetch } from '../auth/useApiFetch';
import type {
  Content,
  ContentAnswer,
  ContentListResponse,
  ContentType,
  CreateContentParams,
  UpdateContentParams,
} from './types';

// Unified Content catalog: management (CRUD) plus RAG Q&A (askContent). All
// scoped server-side to the signed-in creator's partition. This is the
// management successor to the Blog catalog client (api/blogs.ts).

// Optional server-side filters for GET /content. Omitted/empty values are
// dropped by apiFetch's query serializer so they don't constrain the list.
export interface ListContentParams {
  type?: ContentType;
  source?: string;
  status?: string;
  startKey?: string;
}

export async function listContent(
  apiFetch: ApiFetch,
  params: ListContentParams = {},
): Promise<ContentListResponse> {
  return apiFetch<ContentListResponse>('/content', {
    query: {
      type: params.type,
      source: params.source,
      status: params.status,
      startKey: params.startKey,
    },
  });
}

export async function getContent(apiFetch: ApiFetch, contentId: string): Promise<Content> {
  return apiFetch<Content>(`/content/${contentId}`);
}

export async function createContent(apiFetch: ApiFetch, params: CreateContentParams): Promise<Content> {
  return apiFetch<Content>('/content', { method: 'POST', body: params });
}

export async function updateContent(
  apiFetch: ApiFetch,
  contentId: string,
  params: UpdateContentParams,
): Promise<Content> {
  return apiFetch<Content>(`/content/${contentId}`, { method: 'PATCH', body: params });
}

export async function deleteContent(apiFetch: ApiFetch, contentId: string): Promise<void> {
  await apiFetch(`/content/${contentId}`, { method: 'DELETE' });
}

// --- RAG Q&A -----------------------------------------------------------------

export interface AskContentParams {
  question: string;
  // How many chunks to retrieve (1-20). Omit for the server default.
  topK?: number;
  // Restrict the search to a single piece of content instead of the catalog.
  contentId?: string;
  // Restrict the search to a single content type.
  type?: ContentType;
}

export async function askContent(apiFetch: ApiFetch, params: AskContentParams): Promise<ContentAnswer> {
  return apiFetch<ContentAnswer>('/content/ask', {
    method: 'POST',
    body: {
      question: params.question,
      ...(params.topK !== undefined ? { top_k: params.topK } : {}),
      ...(params.contentId ? { content_id: params.contentId } : {}),
      ...(params.type ? { type: params.type } : {}),
    },
  });
}
