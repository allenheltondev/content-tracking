import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import {
  confirmBrief,
  requestUploadUrl,
  submitChatBrief,
  submitPdfBrief,
  uploadPdf,
} from '../api/briefs';
import type { BriefResponse, ChatEntry, ConfirmRequest } from '../api/types';
import SourcePicker from '../components/SourcePicker';
import ReviewForm from '../components/ReviewForm';

type Phase = 'pick' | 'reviewing';

export default function BriefNew(): ReactElement {
  const apiFetch = useApiFetch();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('pick');
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const handleChatSubmit = async (conversation: ChatEntry[]): Promise<void> => {
    setBusy(true);
    setPickError(null);
    try {
      const result = await submitChatBrief(apiFetch, conversation);
      setBrief(result);
      setPhase('reviewing');
    } catch (err) {
      setPickError(formatBriefError(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePdfSubmit = async (file: File): Promise<void> => {
    setBusy(true);
    setPickError(null);
    try {
      const upload = await requestUploadUrl(apiFetch);
      await uploadPdf(upload.upload_url, file);
      const result = await submitPdfBrief(apiFetch, upload.brief_id);
      setBrief(result);
      setPhase('reviewing');
    } catch (err) {
      setPickError(formatBriefError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (payload: ConfirmRequest): Promise<void> => {
    if (!brief) return;
    setBusy(true);
    setConfirmError(null);
    try {
      const result = await confirmBrief(apiFetch, brief.brief_id, payload);
      navigate(`/campaigns/${result.campaign_id}`, {
        state: { fromBriefId: brief.brief_id },
      });
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = (): void => {
    setBrief(null);
    setPhase('pick');
    setConfirmError(null);
  };

  return (
    <section className="brief-new">
      <h1>New brief</h1>
      {phase === 'pick' && (
        <>
          <p className="lead">
            Drop in a vendor brief. The model produces a structured summary you can edit before
            creating a campaign.
          </p>
          {pickError && <p className="form-error">{pickError}</p>}
          <SourcePicker
            busy={busy}
            onSubmitChat={(c) => void handleChatSubmit(c)}
            onSubmitPdf={(f) => void handlePdfSubmit(f)}
          />
        </>
      )}
      {phase === 'reviewing' && brief && (
        <ReviewForm
          brief={brief}
          busy={busy}
          serverError={confirmError}
          onConfirm={(p) => void handleConfirm(p)}
          onDiscard={handleDiscard}
        />
      )}
    </section>
  );
}

function formatBriefError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502) {
      return `The model couldn't parse the brief. Try again or simplify the input. (${err.message})`;
    }
    if (err.status === 413) {
      return 'The brief is too large for the API.';
    }
    if (err.status === 0) {
      return 'Network error. Check your connection and retry.';
    }
    return err.message;
  }
  return (err as Error).message;
}
