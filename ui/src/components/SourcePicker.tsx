import type { ReactElement } from 'react';
import { useState } from 'react';
import { parseChatInput, ChatParseError } from './chatParser';
import { BRIEF_FILE_HINT, briefFileError } from '../api/briefs';
import type { ChatEntry } from '../api/types';
import BriefDropzone from './BriefDropzone';

type Tab = 'file' | 'chat';

interface Props {
  busy: boolean;
  onSubmitChat: (conversation: ChatEntry[]) => void;
  onSubmitFile: (file: File) => void;
}

export default function SourcePicker({ busy, onSubmitChat, onSubmitFile }: Props): ReactElement {
  const [tab, setTab] = useState<Tab>('file');
  const [chatText, setChatText] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const handleChatSubmit = (): void => {
    setChatError(null);
    try {
      const conversation = parseChatInput(chatText);
      onSubmitChat(conversation);
    } catch (err) {
      if (err instanceof ChatParseError) {
        setChatError(err.message);
        return;
      }
      throw err;
    }
  };

  const handleFile = (next: File): void => {
    const invalid = briefFileError(next);
    setFileError(invalid);
    setFile(invalid ? null : next);
  };

  const tabClass = (active: boolean): string =>
    `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
      active
        ? 'border-primary-600 text-primary-600'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="card card-body space-y-4">
      <div className="flex gap-2 border-b border-border" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={tabClass(tab === 'chat')}
          onClick={() => setTab('chat')}
        >
          Paste chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'file'}
          className={tabClass(tab === 'file')}
          onClick={() => setTab('file')}
        >
          Upload file
        </button>
      </div>

      {tab === 'chat' && (
        <div className="space-y-3" role="tabpanel">
          <label htmlFor="chat-input" className="field-label">
            Paste the conversation transcript or a JSON array.
          </label>
          <textarea
            id="chat-input"
            className="input font-mono text-sm"
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder={
              "vendor: Hey, we'd love a 60-second IG reel...\ninfluencer: Sounds good! What's the budget?"
            }
            rows={14}
            disabled={busy}
          />
          <p className="field-hint">
            Either: lines starting with <code className="bg-muted px-1 rounded">vendor:</code>,{' '}
            <code className="bg-muted px-1 rounded">influencer:</code>,{' '}
            <code className="bg-muted px-1 rounded">user:</code>, or{' '}
            <code className="bg-muted px-1 rounded">assistant:</code>. Or a JSON array of{' '}
            <code className="bg-muted px-1 rounded">{'{ role, content }'}</code>.
          </p>
          {chatError && <p className="form-error">{chatError}</p>}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || chatText.trim().length === 0}
            onClick={handleChatSubmit}
          >
            {busy ? 'Summarizing...' : 'Summarize'}
          </button>
        </div>
      )}

      {tab === 'file' && (
        <div className="space-y-3" role="tabpanel">
          <BriefDropzone onFile={handleFile} disabled={busy}>
            {file && (
              <p className="text-sm text-foreground mt-2">
                Selected: {file.name} ({(file.size / 1024).toFixed(0)} KB)
              </p>
            )}
          </BriefDropzone>
          <p className="field-hint">{BRIEF_FILE_HINT}</p>
          {fileError && <p className="form-error">{fileError}</p>}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !file}
            onClick={() => file && onSubmitFile(file)}
          >
            {busy ? 'Uploading and summarizing...' : 'Summarize'}
          </button>
        </div>
      )}
    </div>
  );
}
