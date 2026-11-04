import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '../auth/useApiFetch';
import {
  BRIEF_FILE_HINT,
  briefErrorMessage,
  briefFileError,
  briefFormat,
  createCampaignFromBrief,
  requestStagedBriefUpload,
  uploadBriefFile,
  type BriefFormat,
} from '../api/briefs';
import BriefDropzone from './BriefDropzone';
import Modal from './Modal';

// Starts a campaign from a brief file. The campaign is created once the brief
// has been read, then the Brief tab is where its details get reviewed.
export default function UploadBriefButton({ className }: { className: string }): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Upload brief
      </button>
      {open && <UploadBriefModal onClose={() => setOpen(false)} />}
    </>
  );
}

function UploadBriefModal({ onClose }: { onClose: () => void }): ReactElement {
  const apiFetch = useApiFetch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'idle' | 'uploading' | 'reading'>('idle');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = step !== 'idle';

  const start = async (file: File): Promise<void> => {
    const invalid = briefFileError(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    const format = briefFormat(file) as BriefFormat;
    setError(null);
    setFileName(file.name);
    setStep('uploading');
    try {
      const upload = await requestStagedBriefUpload(apiFetch, format);
      await uploadBriefFile(upload.upload_url, file, format);
      setStep('reading');
      const campaign = await createCampaignFromBrief(apiFetch, {
        uploadId: upload.upload_id,
        format,
        fileName: file.name,
      });
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      navigate(`/campaigns/${campaign.campaign_id}?tab=brief`);
    } catch (err) {
      setError(briefErrorMessage(err));
      setStep('idle');
    }
  };

  return (
    <Modal
      open
      size="md"
      title="Upload a brief"
      description="The campaign is created from it. You review the details next."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="space-y-3">
        {busy ? (
          <div role="status" className="rounded-lg border border-border bg-muted/50 p-6 text-center">
            <p className="font-medium text-foreground [overflow-wrap:anywhere]">{fileName}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {step === 'uploading' ? 'Uploading…' : 'Reading the brief. This can take up to 30 seconds.'}
            </p>
          </div>
        ) : (
          <>
            <BriefDropzone onFile={(file) => void start(file)} />
            <p className="field-hint">{BRIEF_FILE_HINT}</p>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
