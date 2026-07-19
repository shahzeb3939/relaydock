import { useState, type FormEvent } from 'react';
import { InlineAlert, Spinner } from './Feedback';
import { Modal } from './Modal';

export function RenameDeviceModal({
  currentName,
  error,
  loading,
  onClose,
  onRename,
}: {
  currentName: string;
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const trimmed = name.trim();
  const unchanged = trimmed === currentName.trim();
  const canSubmit = trimmed !== '' && !unchanged && !loading;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    onRename(trimmed);
  };

  return (
    <Modal
      title="Rename device"
      description="Pick a name that helps you recognize this machine at a glance."
      onClose={onClose}
    >
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <form className="form-stack" onSubmit={submit}>
        <label>
          Device name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Development laptop"
            maxLength={100}
            autoFocus
            required
          />
          <small>
            The name is only used inside RelayDock. It does not affect the device itself.
          </small>
        </label>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={!canSubmit}>
            {loading && <Spinner />}
            {loading ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
