import type { ApiFetch } from '../auth/useApiFetch';
import type { BlogAnswer } from './types';

// Blog catalog RAG Q&A. Embeds the question server-side, retrieves the nearest
// chunks from the vector index (scoped to the signed-in creator), and answers
// grounded in them. Generation calls Bedrock, so it's a POST; nothing is
// persisted, so there's no matching GET.

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
