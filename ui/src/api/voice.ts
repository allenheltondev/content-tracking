import type { ApiFetch } from '../auth/useApiFetch';
import type { VoiceDraft, VoiceFormat, VoiceProfile, VoiceReflection, VoiceSample } from './types';

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
