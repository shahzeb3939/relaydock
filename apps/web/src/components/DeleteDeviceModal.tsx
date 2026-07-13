import { InlineAlert } from './Feedback';
import { Modal } from './Modal';

export function DeleteDeviceModal({
  deviceName,
  error,
  loading,
  onClose,
  onConfirm,
}: {
  deviceName: string;
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={`Permanently delete ${deviceName}?`}
      description="The revoked device and its operational data will be removed from RelayDock."
      onClose={onClose}
    >
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <p>
        Repositories, actions, job history, retained terminal output, and credentials for this
        device will be permanently deleted. Security audit records are retained. This cannot be
        undone.
      </p>
      <div className="modal-actions">
        <button className="button secondary" type="button" onClick={onClose}>
          Keep device
        </button>
        <button className="button danger" type="button" disabled={loading} onClick={onConfirm}>
          {loading ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
    </Modal>
  );
}
