import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Folder, FolderPlus, ArrowLeft, Pencil, Trash2, Plus, X, Check,
  MoreHorizontal, FolderInput, CornerUpLeft,
} from 'lucide-react';
import AppShell from '../components/AppShell';
import { useToast } from '../components/Toast';
import { useLibraryClient } from '../hooks/useLibraryClient';
import s from './Folders.module.css';

function fmtDur(sec) { const m = Math.floor(sec / 60); return `${m}:${String(sec % 60).padStart(2, '0')}`; }

// T-803: folders and the recordings inside them come from the library data
// layer (PostgreSQL when the server says `library.path === 'v1'`, the legacy
// stores otherwise). Every write follows the recording's own source.
export default function Folders() {
  const { client, ready } = useLibraryClient();
  const toast = useToast();
  const [folders, setFolders] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);        // open folder id | null
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(null); // folder id being renamed
  const [renameVal, setRenameVal] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);

  async function load() {
    if (!client) return;
    try {
      const [f, r] = await Promise.all([client.listFolders(), client.listRecordings()]);
      setFolders(f);
      setRecordings(r);
    } catch (e) { toast.error(e.message || 'Could not load your folders.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (ready) load(); /* eslint-disable-next-line */ }, [ready, client]);

  const countIn = (fid) => recordings.filter((r) => r.folder === fid).length;
  const openFolder = folders.find((f) => f.id === open);
  const inFolder = recordings.filter((r) => r.folder === open);
  const notInFolder = recordings.filter((r) => r.folder !== open);

  async function createFolder() {
    const name = newName.trim();
    if (!name) return;
    const r = await client.createFolder(name);
    if (r.folder) setFolders((f) => [...f, r.folder]); else toast.error(r.error);
    setCreating(false); setNewName('');
  }
  async function rename(id) {
    const name = renameVal.trim();
    if (!name) { setRenaming(null); return; }
    const r = await client.renameFolder(id, name);
    if (r.folder) setFolders((f) => f.map((x) => (x.id === id ? r.folder : x))); else toast.error(r.error);
    setRenaming(null);
  }
  function deleteFolder(f) {
    setConfirm({
      title: `Delete “${f.name}”?`, message: 'The folder is removed. Videos inside it are kept and moved back to your Library.',
      onConfirm: async () => {
        const r = await client.deleteFolder(f.id);
        if (!r.ok) { toast.error('Could not delete the folder.'); return; }
        // move its videos back to no-folder locally
        setRecordings((rs) => rs.map((x) => (x.folder === f.id ? { ...x, folder: null } : x)));
        setFolders((fs) => fs.filter((x) => x.id !== f.id));
        if (open === f.id) setOpen(null);
      },
    });
  }
  async function move(rec, folderId) {
    const r = await client.patchMeta(rec, { folder: folderId });
    if (r.error) { toast.error(r.error); return; }
    setRecordings((rs) => rs.map((x) => (x.id === rec.id ? { ...x, folder: folderId } : x)));
  }

  return (
    <AppShell active="folders">
      {!open ? (
        <>
          <div className={s.head}>
            <h1 className={s.title}>Folders</h1>
            <button className={s.newBtn} onClick={() => { setCreating(true); setNewName(''); }}><FolderPlus size={17} /> New folder</button>
          </div>

          {loading ? <p className={s.muted}>Loading…</p> : (
            <div className={s.folderGrid}>
              {creating && (
                <div className={`${s.folderCard} ${s.folderCreating}`}>
                  <div className={s.folderIcon}><Folder size={26} color="#5b5bf6" /></div>
                  <input className={s.inlineInput} autoFocus value={newName} placeholder="Folder name"
                    onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setCreating(false); }} />
                  <div className={s.inlineActions}>
                    <button className={s.miniPrimary} onClick={createFolder}>Create</button>
                    <button className={s.miniGhost} onClick={() => setCreating(false)}>Cancel</button>
                  </div>
                </div>
              )}
              {folders.map((f) => (
                <FolderCard key={f.id} f={f} count={countIn(f.id)}
                  renaming={renaming === f.id} renameVal={renameVal}
                  onOpen={() => setOpen(f.id)}
                  onRenameStart={() => { setRenaming(f.id); setRenameVal(f.name); }}
                  onRenameChange={setRenameVal} onRenameSave={() => rename(f.id)} onRenameCancel={() => setRenaming(null)}
                  onDelete={() => deleteFolder(f)} />
              ))}
              {!folders.length && !creating && (
                <div className={s.emptyState}>
                  <div className={s.emptyIcon}><Folder size={28} color="#5b5bf6" /></div>
                  <h3>No folders yet</h3>
                  <p>Create folders to organize your recordings like a file manager.</p>
                  <button className={s.newBtn} onClick={() => setCreating(true)}><FolderPlus size={16} /> New folder</button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <button className={s.back} onClick={() => setOpen(null)}><ArrowLeft size={16} /> All folders</button>
          <div className={s.head}>
            <div className={s.folderTitle}>
              <Folder size={24} color="#5b5bf6" />
              {renaming === open ? (
                <input className={s.titleInput} autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(open); if (e.key === 'Escape') setRenaming(null); }} onBlur={() => rename(open)} />
              ) : (
                <>
                  <h1 className={s.title}>{openFolder?.name}</h1>
                  <button className={s.iconBtn} title="Rename" onClick={() => { setRenaming(open); setRenameVal(openFolder.name); }}><Pencil size={15} /></button>
                </>
              )}
              <span className={s.muted}>· {inFolder.length} videos</span>
            </div>
            <div className={s.headActions}>
              <button className={s.newBtn} onClick={() => setAddOpen(true)}><Plus size={16} /> Add videos</button>
              <button className={s.dangerGhost} onClick={() => deleteFolder(openFolder)}><Trash2 size={15} /> Delete folder</button>
            </div>
          </div>

          {inFolder.length === 0 ? (
            <div className={s.emptyState}>
              <div className={s.emptyIcon}><FolderInput size={26} color="#5b5bf6" /></div>
              <h3>This folder is empty</h3>
              <p>Add recordings to organize them here.</p>
              <button className={s.newBtn} onClick={() => setAddOpen(true)}><Plus size={16} /> Add videos</button>
            </div>
          ) : (
            <div className={s.fileList}>
              {inFolder.map((r) => (
                <div key={r.id} className={s.fileRow}>
                  <Link to={`/watch/${r.id}`} className={s.fileThumb}>
                    {r.thumbnail ? <img src={r.thumbnail} alt="" /> : <div className={s.fileThumbBlank} />}
                    <span className={s.fileDur}>{fmtDur(r.duration)}</span>
                  </Link>
                  <div className={s.fileMain}><strong>{r.title}</strong><small>{r.views || 0} views</small></div>
                  <button className={s.removeBtn} title="Remove from folder" onClick={() => move(r, null)}><CornerUpLeft size={15} /> Remove</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Add-videos picker */}
      {addOpen && (
        <div className={s.modalBg} onClick={() => setAddOpen(false)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalHead}><strong>Add videos to “{openFolder?.name}”</strong><button className={s.iconBtn} onClick={() => setAddOpen(false)}><X size={18} /></button></div>
            {notInFolder.length === 0 ? <p className={s.muted}>All your videos are already in this folder.</p> : (
              <div className={s.pickList}>
                {notInFolder.map((r) => (
                  <div key={r.id} className={s.pickRow}>
                    <div className={s.fileThumbSm}>{r.thumbnail ? <img src={r.thumbnail} alt="" /> : <div className={s.fileThumbBlank} />}</div>
                    <div className={s.fileMain}><strong>{r.title}</strong><small>{r.folder ? 'In another folder' : 'No folder'}</small></div>
                    <button className={s.miniPrimary} onClick={() => move(r, open)}><Plus size={14} /> Add</button>
                  </div>
                ))}
              </div>
            )}
            <div className={s.modalActions}><button className={s.miniGhost} onClick={() => setAddOpen(false)}>Done</button></div>
          </div>
        </div>
      )}

      {confirm && (
        <div className={s.modalBg} onClick={() => setConfirm(null)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h2 className={s.modalTitleH}>{confirm.title}</h2>
            <p className={s.muted}>{confirm.message}</p>
            <div className={s.modalActions}>
              <button className={s.miniGhost} onClick={() => setConfirm(null)}>Cancel</button>
              <button className={s.dangerBtn} onClick={async () => { const fn = confirm.onConfirm; setConfirm(null); if (fn) await fn(); }}>Delete folder</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function FolderCard({ f, count, renaming, renameVal, onOpen, onRenameStart, onRenameChange, onRenameSave, onRenameCancel, onDelete }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setMenu(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className={s.folderCard}>
      <button className={s.folderOpen} onClick={renaming ? undefined : onOpen}>
        <div className={s.folderIcon}><Folder size={26} color="#5b5bf6" /></div>
      </button>
      {renaming ? (
        <input className={s.inlineInput} autoFocus value={renameVal} onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRenameSave(); if (e.key === 'Escape') onRenameCancel(); }} onBlur={onRenameSave} />
      ) : (
        <div className={s.folderInfo} onClick={onOpen}><strong>{f.name}</strong><small>{count} video{count === 1 ? '' : 's'}</small></div>
      )}
      <div className={s.folderMenuWrap} ref={ref}>
        <button className={s.iconBtn} onClick={() => setMenu((m) => !m)}><MoreHorizontal size={17} /></button>
        {menu && (
          <div className={s.menu}>
            <button className={s.menuItem} onClick={() => { setMenu(false); onOpen(); }}><FolderInput size={15} /> Open</button>
            <button className={s.menuItem} onClick={() => { setMenu(false); onRenameStart(); }}><Pencil size={15} /> Rename</button>
            <div className={s.menuDivider} />
            <button className={`${s.menuItem} ${s.menuDanger}`} onClick={() => { setMenu(false); onDelete(); }}><Trash2 size={15} /> Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
