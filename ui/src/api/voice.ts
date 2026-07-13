import type { ApiFetch } from '../auth/useApiFetch';
import type {
  VoiceAssessment,
  VoiceDraft,
  VoiceFormat,
  VoiceOverviewEntry,
  VoiceProfile,
  VoiceReflection,
  VoiceSample,
} from './types';

// Voice feature client. Composing and reflecting call Bedrock (POST); the style
// learning itself happens server-side off the DynamoDB stream after a sample is
// saved. Platforms "blog" is long-form; the rest are short-form social.
export const VOICE_PLATFORMS = [
  'blog',
  'x',
  'linkedin',
  'bluesky',
  'instagram',
  'threads',
  'mastodon',
  'medium',
  'devto',
] as const;

// Display names so selects/labels read "LinkedIn" / "Dev.to", not "linkedin".
export const PLATFORM_LABELS: Record<string, string> = {
  blog: 'Blog',
  x: 'X',
  linkedin: 'LinkedIn',
  bluesky: 'Bluesky',
  instagram: 'Instagram',
  threads: 'Threads',
  mastodon: 'Mastodon',
  medium: 'Medium',
  devto: 'Dev.to',
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

// Soft character limits for short-form platforms, used to warn (not block) when
// a social draft runs long. Absent = no limit shown (blog, medium, dev.to).
export const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  x: 280,
  bluesky: 300,
  mastodon: 500,
  threads: 500,
  instagram: 2200,
  linkedin: 3000,
};

export interface ComposeParams {
  topic: string;
  platform: string;
  format: VoiceFormat;
  guidance?: string;
}

export async function composeVoice(apiFetch: ApiFetch, params: ComposeParams): Promise<VoiceDraft> {
  return apiFetch<VoiceDraft>('/voice/compose', {
    method: 'POST',
    body: {
      topic: params.topic,
      platform: params.platform,
      format: params.format,
      ...(params.guidance ? { guidance: params.guidance } : {}),
    },
  });
}

export interface CreateSampleParams {
  text: string;
  platform: string;
  format: VoiceFormat;
  source?: 'manual' | 'generated';
}

export async function createVoiceSample(apiFetch: ApiFetch, params: CreateSampleParams): Promise<VoiceSample> {
  return apiFetch<VoiceSample>('/voice/samples', {
    method: 'POST',
    body: {
      text: params.text,
      platform: params.platform,
      format: params.format,
      ...(params.source ? { source: params.source } : {}),
    },
  });
}

export async function listVoiceSamples(apiFetch: ApiFetch, platform: string): Promise<{ samples: VoiceSample[] }> {
  return apiFetch<{ samples: VoiceSample[] }>('/voice/samples', { query: { platform } });
}

export async function deleteVoiceSample(apiFetch: ApiFetch, id: string, platform: string): Promise<void> {
  await apiFetch(`/voice/samples/${id}`, { method: 'DELETE', query: { platform } });
}

// Mute (exclude from the voice) or unmute a sample. Muting is reversible and,
// for auto-captured posts, durable across later edits.
export async function setVoiceSampleMuted(
  apiFetch: ApiFetch,
  id: string,
  platform: string,
  muted: boolean,
): Promise<VoiceSample> {
  return apiFetch<VoiceSample>(`/voice/samples/${id}`, {
    method: 'PATCH',
    query: { platform },
    body: { muted },
  });
}

// Set (or clear with null) the steering note that biases the next reflection.
export async function setVoiceSteering(
  apiFetch: ApiFetch,
  platform: string,
  note: string | null,
): Promise<{ profile: VoiceProfile | null }> {
  return apiFetch<{ profile: VoiceProfile | null }>(`/voice/profiles/${platform}/steering`, {
    method: 'PUT',
    body: { note },
  });
}

export async function listVoiceProfiles(apiFetch: ApiFetch): Promise<{ profiles: VoiceProfile[] }> {
  return apiFetch<{ profiles: VoiceProfile[] }>('/voice/profiles');
}

export async function getVoiceProfile(
  apiFetch: ApiFetch,
  platform: string,
): Promise<{ profile: VoiceProfile | null; reflections: VoiceReflection[] }> {
  return apiFetch<{ profile: VoiceProfile | null; reflections: VoiceReflection[] }>(`/voice/profiles/${platform}`);
}

export async function reflectVoiceProfile(apiFetch: ApiFetch, platform: string): Promise<{ profile: VoiceProfile | null }> {
  return apiFetch<{ profile: VoiceProfile | null }>(`/voice/profiles/${platform}/reflect`, {
    method: 'POST',
    body: {},
  });
}

// The flagship read: portrait + corpus transparency for every platform, in one call.
export async function getVoiceOverview(apiFetch: ApiFetch): Promise<{ platforms: VoiceOverviewEntry[] }> {
  return apiFetch<{ platforms: VoiceOverviewEntry[] }>('/voice/overview');
}

// Grade an arbitrary draft against the learned voice (paste-and-score).
export async function checkVoice(
  apiFetch: ApiFetch,
  params: { draft: string; platform: string; format: VoiceFormat },
): Promise<VoiceAssessment> {
  return apiFetch<VoiceAssessment>('/voice/check', {
    method: 'POST',
    body: { draft: params.draft, platform: params.platform, format: params.format },
  });
}
