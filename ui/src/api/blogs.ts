import type { ApiFetch } from '../auth/useApiFetch';
import type {
  Blog,
  BlogAnswer,
  BlogListResponse,
  CrosspostPlatform,
  CrosspostRun,
  CrosspostStatus,
} from './types';

// Blog catalog: management (CRUD + cross-post) plus RAG Q&A (askBlog). All
// scoped server-side to the signed-in creator's partition.

export const CROSSPOST_PLATFORMS: CrosspostPlatform[] = ['dev', 'medium', 'hashnode'];

export async function listBlogs(apiFetch: ApiFetch, startKey?: string): Promise<BlogListResponse> {
  return apiFetch<BlogListResponse>('/blogs', { query: startKey ? { startKey } : {} });
}

export async function getBlogPost(apiFetch: ApiFetch, blogId: string): Promise<Blog> {
  return apiFetch<Blog>(`/blogs/${blogId}`);
}

export interface CreateBlogParams {
  title: string;
  slug: string;
  content_markdown: string;
  description?: string;
  tags?: string[];
  canonical_url?: string;
}

export async function createBlogPost(apiFetch: ApiFetch, params: CreateBlogParams): Promise<Blog> {
  return apiFetch<Blog>('/blogs', { method: 'POST', body: params });
}

export async function deleteBlogPost(apiFetch: ApiFetch, blogId: string): Promise<void> {
  await apiFetch(`/blogs/${blogId}`, { method: 'DELETE' });
}

export async function crosspostBlog(
  apiFetch: ApiFetch,
  blogId: string,
  platforms: CrosspostPlatform[],
  staggerDays?: number,
): Promise<Pick<CrosspostRun, 'run_id' | 'status' | 'platforms'>> {
  return apiFetch(`/blogs/${blogId}/crosspost`, {
    method: 'POST',
    body: { platforms, ...(staggerDays ? { stagger_days: staggerDays } : {}) },
  });
}

export async function getCrosspostStatus(
  apiFetch: ApiFetch,
  blogId: string,
  runId?: string,
): Promise<CrosspostStatus> {
  return apiFetch<CrosspostStatus>(`/blogs/${blogId}/crosspost-status`, {
    query: runId ? { run_id: runId } : {},
  });
}

// --- RAG Q&A -----------------------------------------------------------------

export interface AskBlogParams {
  question: string;
  // How many chunks to retrieve (1-20). Omit for the server default.
  topK?: number;
  // Restrict the search to a single post instead of the whole catalog.
  blogId?: string;
}

export async function askBlog(apiFetch: ApiFetch, params: AskBlogParams): Promise<BlogAnswer> {
  return apiFetch<BlogAnswer>('/blogs/ask', {
    method: 'POST',
    body: {
      question: params.question,
      ...(params.topK !== undefined ? { top_k: params.topK } : {}),
      ...(params.blogId ? { blog_id: params.blogId } : {}),
    },
  });
}
