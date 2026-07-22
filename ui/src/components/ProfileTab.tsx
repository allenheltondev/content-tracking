import type { ChangeEvent, ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { getProfile, updateProfile, uploadProfileImage } from '../api/profile';
import TagsInput from './TagsInput';
import type {
  ProfileFeaturedCollaboration,
  ProfileImageKind,
  ProfileRateCardItem,
  ProfileResponse,
  ProfileSocialAccount,
  ProfileTestimonial,
  ProfileUpdateRequest,
} from '../api/types';

// Editable working copy of the creator profile. Mirrors the API's nested
// shape but with the array/scalar fields the form binds to directly.
interface FormState {
  displayName: string;
  tagline: string;
  bio: string;
  location: string;
  contactEmail: string;
  accentColor: string;
  publicSlug: string;
  niches: string[];
  socialAccounts: ProfileSocialAccount[];
  rateCard: ProfileRateCardItem[];
  testimonials: ProfileTestimonial[];
  collaborations: ProfileFeaturedCollaboration[];
}

const EMPTY: FormState = {
  displayName: '',
  tagline: '',
  bio: '',
  location: '',
  contactEmail: '',
  accentColor: '#2256c7',
  publicSlug: '',
  niches: [],
  socialAccounts: [],
  rateCard: [],
  testimonials: [],
  collaborations: [],
};

function fromProfile(res: ProfileResponse): FormState {
  return {
    displayName: res.identity.display_name ?? '',
    tagline: res.identity.tagline ?? '',
    bio: res.identity.bio ?? '',
    location: res.identity.location ?? '',
    contactEmail: res.identity.contact_email ?? '',
    accentColor: res.identity.accent_color ?? '#2256c7',
    publicSlug: res.public_media_kit.slug ?? '',
    niches: res.identity.niches ?? [],
    socialAccounts: res.social_accounts ?? [],
    rateCard: res.rate_card ?? [],
    testimonials: res.testimonials ?? [],
    collaborations: res.featured_collaborations ?? [],
  };
}

// Builds the PUT body. Text fields send their trimmed value or null to
// clear; arrays are always sent so removals persist.
function toPayload(s: FormState): ProfileUpdateRequest {
  const orNull = (v: string): string | null => (v.trim() ? v.trim() : null);
  return {
    display_name: orNull(s.displayName),
    tagline: orNull(s.tagline),
    bio: orNull(s.bio),
    location: orNull(s.location),
    contact_email: orNull(s.contactEmail),
    accent_color: orNull(s.accentColor),
    public_slug: s.publicSlug.trim() ? s.publicSlug.trim().toLowerCase() : null,
    niches: s.niches,
    social_accounts: s.socialAccounts
      .filter((a) => a.platform.trim() && (a.handle?.trim() || a.url?.trim()))
      .map((a) => ({
        platform: a.platform.trim(),
        handle: a.handle?.trim() ? a.handle.trim() : null,
        url: a.url?.trim() ? a.url.trim() : null,
        followers: a.followers,
      })),
    rate_card: s.rateCard
      .filter((r) => r.deliverable.trim())
      .map((r) => ({
        deliverable: r.deliverable.trim(),
        description: r.description?.trim() ? r.description.trim() : null,
        price: r.price,
        currency: r.currency || 'USD',
      })),
    testimonials: s.testimonials
      .filter((t) => t.quote.trim())
      .map((t) => ({
        quote: t.quote.trim(),
        author: t.author?.trim() ? t.author.trim() : null,
        role: t.role?.trim() ? t.role.trim() : null,
        company: t.company?.trim() ? t.company.trim() : null,
      })),
    featured_collaborations: s.collaborations
      .filter((c) => c.brand.trim())
      .map((c) => ({
        brand: c.brand.trim(),
        description: c.description?.trim() ? c.description.trim() : null,
        url: c.url?.trim() ? c.url.trim() : null,
        year: c.year,
      })),
  };
}

export default function ProfileTab(): ReactElement {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(apiFetch),
  });
  const profile: ProfileResponse | null = profileQuery.data ?? null;
  const loadError = profileQuery.error ? (profileQuery.error as Error).message : null;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the working copy whenever fresh profile data lands (initial load and
  // after a save writes the response into the cache).
  useEffect(() => {
    if (profileQuery.data) setForm(fromProfile(profileQuery.data));
  }, [profileQuery.data]);

  const patch = (changes: Partial<FormState>): void =>
    setForm((prev) => ({ ...prev, ...changes }));

  const submit = async (extra: ProfileUpdateRequest = {}): Promise<void> => {
    setSaveError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await updateProfile(apiFetch, { ...toPayload(form), ...extra });
      // The seeding effect above re-fills the form from this.
      queryClient.setQueryData(['profile'], res);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Your profile powers the media kit you share with brands. Everything here is optional —
        fill in what you want to show.
      </p>

      {loadError && <p className="form-error">Could not load profile: {loadError}</p>}

      <ImagesSection
        profile={profile}
        busy={busy}
        onUploaded={(kind, key) => void submit(kind === 'avatar' ? { avatar_key: key } : { logo_key: key })}
        onClear={(kind) => void submit(kind === 'avatar' ? { avatar_key: null } : { logo_key: null })}
      />

      <div className="card card-body space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Identity</h2>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="field-label">Display name</span>
            <input
              type="text"
              className="input"
              placeholder="e.g. Allen Helton"
              value={form.displayName}
              maxLength={80}
              onChange={(e) => patch({ displayName: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="field-label">Location</span>
            <input
              type="text"
              className="input"
              placeholder="e.g. Tennessee, USA"
              value={form.location}
              maxLength={120}
              onChange={(e) => patch({ location: e.target.value })}
              disabled={busy}
            />
          </label>
        </div>

        <label className="block">
          <span className="field-label">Tagline</span>
          <input
            type="text"
            className="input"
            placeholder="e.g. Serverless educator & developer advocate"
            value={form.tagline}
            maxLength={160}
            onChange={(e) => patch({ tagline: e.target.value })}
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="field-label">Bio</span>
          <textarea
            className="input"
            rows={4}
            placeholder="A short paragraph about who you are and what you create."
            value={form.bio}
            maxLength={2000}
            onChange={(e) => patch({ bio: e.target.value })}
            disabled={busy}
          />
        </label>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="field-label">Contact email</span>
            <input
              type="email"
              className="input"
              placeholder="partnerships@you.com"
              value={form.contactEmail}
              onChange={(e) => patch({ contactEmail: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="field-label">Accent color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="h-9 w-12 rounded border border-border bg-surface"
                value={/^#[0-9a-fA-F]{6}$/.test(form.accentColor) ? form.accentColor : '#2256c7'}
                onChange={(e) => patch({ accentColor: e.target.value })}
                disabled={busy}
                aria-label="Accent color"
              />
              <input
                type="text"
                className="input flex-1 font-mono text-sm"
                placeholder="#2256c7"
                value={form.accentColor}
                onChange={(e) => patch({ accentColor: e.target.value })}
                disabled={busy}
              />
            </div>
          </label>
        </div>

        <label className="block">
          <span className="field-label">Niches</span>
          <TagsInput
            tags={form.niches}
            onChange={(niches) => patch({ niches })}
            placeholder="Add a niche (e.g. AWS, Serverless)"
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="field-label">Public media-kit URL</span>
          <input
            type="text"
            className="input font-mono text-sm"
            placeholder="your-name"
            value={form.publicSlug}
            onChange={(e) => patch({ publicSlug: e.target.value })}
            disabled={busy}
          />
          <span className="field-hint">
            The vanity slug for your shareable public media kit (e.g. <code>your-name</code> →{' '}
            <code>/your-name</code>). Lowercase letters, digits, and hyphens. Set this, save, then
            publish from the Media kit page.
          </span>
        </label>
      </div>

      <SocialAccountsSection
        accounts={form.socialAccounts}
        busy={busy}
        onChange={(socialAccounts) => patch({ socialAccounts })}
      />

      <RateCardSection
        items={form.rateCard}
        busy={busy}
        onChange={(rateCard) => patch({ rateCard })}
      />

      <TestimonialsSection
        items={form.testimonials}
        busy={busy}
        onChange={(testimonials) => patch({ testimonials })}
      />

      <CollaborationsSection
        items={form.collaborations}
        busy={busy}
        onChange={(collaborations) => patch({ collaborations })}
      />

      {saveError && <p className="form-error">{saveError}</p>}
      {saved && <p className="text-sm text-success-700">Profile saved.</p>}

      <div className="flex justify-end">
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}

function ImagesSection({
  profile,
  busy,
  onUploaded,
  onClear,
}: {
  profile: ProfileResponse | null;
  busy: boolean;
  onUploaded: (kind: ProfileImageKind, key: string) => void;
  onClear: (kind: ProfileImageKind) => void;
}): ReactElement {
  return (
    <div className="card card-body space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Photos</h2>
      <div className="grid sm:grid-cols-2 gap-4">
        <ImageUploader
          kind="avatar"
          label="Avatar"
          currentUrl={profile?.identity.avatar_url ?? null}
          hasImage={Boolean(profile?.identity.avatar_key)}
          rounded
          busy={busy}
          onUploaded={onUploaded}
          onClear={onClear}
        />
        <ImageUploader
          kind="logo"
          label="Logo"
          currentUrl={profile?.identity.logo_url ?? null}
          hasImage={Boolean(profile?.identity.logo_key)}
          busy={busy}
          onUploaded={onUploaded}
          onClear={onClear}
        />
      </div>
    </div>
  );
}

function ImageUploader({
  kind,
  label,
  currentUrl,
  hasImage,
  rounded = false,
  busy,
  onUploaded,
  onClear,
}: {
  kind: ProfileImageKind;
  label: string;
  currentUrl: string | null;
  hasImage: boolean;
  rounded?: boolean;
  busy: boolean;
  onUploaded: (kind: ProfileImageKind, key: string) => void;
  onClear: (kind: ProfileImageKind) => void;
}): ReactElement {
  const apiFetch = useApiFetch();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    uploadProfileImage(apiFetch, kind, file)
      .then((key) => onUploaded(kind, key))
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      });
  };

  return (
    <div className="space-y-2">
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-3">
        <div
          className={`h-16 w-16 flex items-center justify-center overflow-hidden bg-muted border border-border ${
            rounded ? 'rounded-full' : 'rounded-lg'
          }`}
        >
          {currentUrl ? (
            <img src={currentUrl} alt={label} className="h-full w-full object-cover" />
          ) : (
            <span className="text-xs text-muted-foreground">None</span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={pick}
            disabled={busy || uploading}
          />
          <button
            type="button"
            className="btn btn-secondary text-sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy || uploading}
          >
            {uploading ? 'Uploading…' : hasImage ? 'Replace' : 'Upload'}
          </button>
          {hasImage && (
            <button
              type="button"
              className="btn-link text-error-600 text-sm"
              onClick={() => onClear(kind)}
              disabled={busy || uploading}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

// Generic "list of objects" editor scaffold: header, add button, and an
// empty hint. Each section below renders its own rows.
function ListSection({
  title,
  hint,
  addLabel,
  onAdd,
  busy,
  empty,
  children,
}: {
  title: string;
  hint: string;
  addLabel: string;
  onAdd: () => void;
  busy: boolean;
  empty: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="card card-body space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        <button type="button" className="btn btn-secondary text-sm shrink-0" onClick={onAdd} disabled={busy}>
          {addLabel}
        </button>
      </div>
      {empty ? (
        <p className="text-sm text-muted-foreground italic">Nothing added yet.</p>
      ) : (
        <div className="space-y-3">{children}</div>
      )}
    </div>
  );
}

function RemoveButton({ onClick, busy }: { onClick: () => void; busy: boolean }): ReactElement {
  return (
    <button
      type="button"
      className="btn-link text-error-600 text-sm shrink-0"
      onClick={onClick}
      disabled={busy}
      aria-label="Remove"
    >
      Remove
    </button>
  );
}

function SocialAccountsSection({
  accounts,
  busy,
  onChange,
}: {
  accounts: ProfileSocialAccount[];
  busy: boolean;
  onChange: (a: ProfileSocialAccount[]) => void;
}): ReactElement {
  const update = (i: number, changes: Partial<ProfileSocialAccount>): void =>
    onChange(accounts.map((a, j) => (j === i ? { ...a, ...changes } : a)));
  return (
    <ListSection
      title="Social accounts"
      hint="Each platform you're on, with follower counts that roll up on the kit."
      addLabel="Add account"
      busy={busy}
      empty={accounts.length === 0}
      onAdd={() => onChange([...accounts, { platform: '', handle: '', url: '', followers: null }])}
    >
      {accounts.map((a, i) => (
        <div key={i} className="grid sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-start">
          <input
            type="text"
            className="input"
            placeholder="Platform (e.g. youtube)"
            value={a.platform}
            onChange={(e) => update(i, { platform: e.target.value })}
            disabled={busy}
          />
          <input
            type="text"
            className="input"
            placeholder="Handle (@you)"
            value={a.handle ?? ''}
            onChange={(e) => update(i, { handle: e.target.value })}
            disabled={busy}
          />
          <input
            type="text"
            className="input"
            placeholder="URL (optional)"
            value={a.url ?? ''}
            onChange={(e) => update(i, { url: e.target.value })}
            disabled={busy}
          />
          <div className="flex gap-2 items-center">
            <input
              type="number"
              min={0}
              className="input w-28"
              placeholder="Followers"
              value={a.followers ?? ''}
              onChange={(e) =>
                update(i, { followers: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })
              }
              disabled={busy}
            />
            <RemoveButton busy={busy} onClick={() => onChange(accounts.filter((_, j) => j !== i))} />
          </div>
        </div>
      ))}
    </ListSection>
  );
}

function RateCardSection({
  items,
  busy,
  onChange,
}: {
  items: ProfileRateCardItem[];
  busy: boolean;
  onChange: (r: ProfileRateCardItem[]) => void;
}): ReactElement {
  const update = (i: number, changes: Partial<ProfileRateCardItem>): void =>
    onChange(items.map((r, j) => (j === i ? { ...r, ...changes } : r)));
  return (
    <ListSection
      title="Rate card"
      hint="Your pricing per deliverable. Leave a price blank for “on request”."
      addLabel="Add rate"
      busy={busy}
      empty={items.length === 0}
      onAdd={() => onChange([...items, { deliverable: '', description: null, price: null, currency: 'USD' }])}
    >
      {items.map((r, i) => (
        <div key={i} className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0">
          <div className="grid sm:grid-cols-[1fr_140px_100px_auto] gap-2 items-start">
            <input
              type="text"
              className="input"
              placeholder="Deliverable (e.g. Sponsored video)"
              value={r.deliverable}
              onChange={(e) => update(i, { deliverable: e.target.value })}
              disabled={busy}
            />
            <input
              type="number"
              min={0}
              className="input"
              placeholder="Price"
              value={r.price ?? ''}
              onChange={(e) =>
                update(i, { price: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })
              }
              disabled={busy}
            />
            <input
              type="text"
              className="input uppercase"
              placeholder="USD"
              maxLength={3}
              value={r.currency}
              onChange={(e) => update(i, { currency: e.target.value.toUpperCase() })}
              disabled={busy}
            />
            <RemoveButton busy={busy} onClick={() => onChange(items.filter((_, j) => j !== i))} />
          </div>
          <input
            type="text"
            className="input"
            placeholder="Description (optional)"
            value={r.description ?? ''}
            onChange={(e) => update(i, { description: e.target.value })}
            disabled={busy}
          />
        </div>
      ))}
    </ListSection>
  );
}

function TestimonialsSection({
  items,
  busy,
  onChange,
}: {
  items: ProfileTestimonial[];
  busy: boolean;
  onChange: (t: ProfileTestimonial[]) => void;
}): ReactElement {
  const update = (i: number, changes: Partial<ProfileTestimonial>): void =>
    onChange(items.map((t, j) => (j === i ? { ...t, ...changes } : t)));
  return (
    <ListSection
      title="Testimonials"
      hint="Quotes from brands you've worked with."
      addLabel="Add testimonial"
      busy={busy}
      empty={items.length === 0}
      onAdd={() => onChange([...items, { quote: '', author: null, role: null, company: null }])}
    >
      {items.map((t, i) => (
        <div key={i} className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0">
          <div className="flex justify-between gap-2">
            <span className="field-label">Quote {i + 1}</span>
            <RemoveButton busy={busy} onClick={() => onChange(items.filter((_, j) => j !== i))} />
          </div>
          <textarea
            className="input"
            rows={2}
            placeholder="“Working with them was fantastic…”"
            value={t.quote}
            onChange={(e) => update(i, { quote: e.target.value })}
            disabled={busy}
          />
          <div className="grid sm:grid-cols-3 gap-2">
            <input
              type="text"
              className="input"
              placeholder="Author"
              value={t.author ?? ''}
              onChange={(e) => update(i, { author: e.target.value })}
              disabled={busy}
            />
            <input
              type="text"
              className="input"
              placeholder="Role"
              value={t.role ?? ''}
              onChange={(e) => update(i, { role: e.target.value })}
              disabled={busy}
            />
            <input
              type="text"
              className="input"
              placeholder="Company"
              value={t.company ?? ''}
              onChange={(e) => update(i, { company: e.target.value })}
              disabled={busy}
            />
          </div>
        </div>
      ))}
    </ListSection>
  );
}

function CollaborationsSection({
  items,
  busy,
  onChange,
}: {
  items: ProfileFeaturedCollaboration[];
  busy: boolean;
  onChange: (c: ProfileFeaturedCollaboration[]) => void;
}): ReactElement {
  const update = (i: number, changes: Partial<ProfileFeaturedCollaboration>): void =>
    onChange(items.map((c, j) => (j === i ? { ...c, ...changes } : c)));
  return (
    <ListSection
      title="Featured collaborations"
      hint="Notable brands you've partnered with."
      addLabel="Add collaboration"
      busy={busy}
      empty={items.length === 0}
      onAdd={() => onChange([...items, { brand: '', description: null, url: null, year: null }])}
    >
      {items.map((c, i) => (
        <div key={i} className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0">
          <div className="grid sm:grid-cols-[1fr_100px_auto] gap-2 items-start">
            <input
              type="text"
              className="input"
              placeholder="Brand"
              value={c.brand}
              onChange={(e) => update(i, { brand: e.target.value })}
              disabled={busy}
            />
            <input
              type="number"
              className="input"
              placeholder="Year"
              value={c.year ?? ''}
              onChange={(e) =>
                update(i, { year: e.target.value === '' ? null : Number(e.target.value) })
              }
              disabled={busy}
            />
            <RemoveButton busy={busy} onClick={() => onChange(items.filter((_, j) => j !== i))} />
          </div>
          <input
            type="text"
            className="input"
            placeholder="URL (optional)"
            value={c.url ?? ''}
            onChange={(e) => update(i, { url: e.target.value })}
            disabled={busy}
          />
          <input
            type="text"
            className="input"
            placeholder="Description (optional)"
            value={c.description ?? ''}
            onChange={(e) => update(i, { description: e.target.value })}
            disabled={busy}
          />
        </div>
      ))}
    </ListSection>
  );
}
