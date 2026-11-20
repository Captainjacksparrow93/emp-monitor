import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../util.js';
import PolicyEditor from '../components/PolicyEditor.jsx';
import { Loading, useCanWrite, useToast } from '../components/ui.jsx';

export default function Policy() {
  const settings = useApi('/settings');
  const canWrite = useCanWrite();
  const toast = useToast();
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings.data) setDraft(settings.data.policy); }, [settings.data]);
  if (!draft) return <Loading />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data.policy);

  const save = async () => {
    setBusy(true);
    try {
      const p = await api('/settings/policy', { method: 'PUT', body: draft });
      settings.setData({ ...settings.data, policy: p });
      toast('Policy saved — agents pick it up on their next heartbeat');
    } catch (e) { toast(e, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Monitoring policy</h1><div className="sub">Default settings for every machine. Individual machines can override these on their Policy tab.</div></div>
        {canWrite && (
          <div className="row">
            <button disabled={!dirty} onClick={() => setDraft(settings.data.policy)}>Discard</button>
            <button onClick={() => setDraft(settings.data.defaultPolicy)}>Reset to defaults</button>
            <button className="primary" disabled={!dirty || busy} onClick={save}>Save policy</button>
          </div>
        )}
      </div>
      <PolicyEditor value={draft} onChange={setDraft} disabled={!canWrite} />
    </>
  );
}
