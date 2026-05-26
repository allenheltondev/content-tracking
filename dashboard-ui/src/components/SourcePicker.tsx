import type { ReactElement } from 'react';
import { useState } from 'react';
import { parseChatInput, ChatParseError } from './chatParser';
import type { ChatEntry } from '../api/types';

type Tab = 'pdf' | 'chat';

const MAX_PDF_BYTES = 10 * 1024 * 1024;

interface Props {
  busy: boolean;
  onSubmitChat: (conversation: ChatEntry[]) => void;
  onSubmitPdf: (file: File) => void;
}

export default function SourcePicker({ busy, onSubmitChat, onSubmitPdf }: Props): ReactElement {
  const [tab, setTab] = useState<Tab>('chat');
  const [chatText, setChatText] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

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
    if (next.type !== 'application/pdf' && !next.name.toLowerCase().endsWith('.pdf')) {
      setFileError('Only PDF files are accepted.');
      return;
    }
    if (next.size > MAX_PDF_BYTES) {
      setFileError(`File is ${(next.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`);
      return;
    }
    setFileError(null);
    setFile(next);
  };

  return (
    <div className="source-picker">
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={tab === 'chat' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('chat')}
        >
          Paste chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pdf'}
          className={tab === 'pdf' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('pdf')}
        >
          Upload PDF
        </button>
      </div>

      {tab === 'chat' && (
        <div className="tab-panel" role="tabpanel">
          <label htmlFor="chat-input" className="field-label">
            Paste the conversation transcript or a JSON array.
          </label>
          <textarea
            id="chat-input"
            className="chat-textarea"
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder={
              'vendor: Hey, we\'d love a 60-second IG reel...\ninfluencer: Sounds good! What\'s the budget?'
            }
            rows={14}
            disabled={busy}
          />
          <p className="field-hint">
            Either: lines starting with <code>vendor:</code>, <code>influencer:</code>,{' '}
            <code>user:</code>, or <code>assistant:</code>. Or a JSON array of{' '}
            <code>{'{ role, content }'}</code>.
          </p>
          {chatError && <p className="form-error">{chatError}</p>}
          <button
            type="button"
            className="primary"
            disabled={busy || chatText.trim().length === 0}
            onClick={handleChatSubmit}
          >
            {busy ? 'Summarizing...' : 'Summarize'}
          </button>
        </div>
      )}

      {tab === 'pdf' && (
        <div className="tab-panel" role="tabpanel">
          <div
            className={dragOver ? 'dropzone dropzone-active' : 'dropzone'}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files[0];
              if (dropped) handleFile(dropped);
            }}
          >
            <p>Drag a PDF here, or pick a file.</p>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) handleFile(picked);
              }}
              disabled={busy}
            />
            {file && (
              <p className="dropzone-file">
                Selected: {file.name} ({(file.size / 1024).toFixed(0)} KB)
              </p>
            )}
          </div>
          <p className="field-hint">PDF only. 10 MB max.</p>
          {fileError && <p className="form-error">{fileError}</p>}
          <button
            type="button"
            className="primary"
            disabled={busy || !file}
            onClick={() => file && onSubmitPdf(file)}
          >
            {busy ? 'Uploading and summarizing...' : 'Summarize'}
          </button>
        </div>
      )}
    </div>
  );
}
