import { useEffect, useState } from 'react';
import { post } from '../api';
import { ErrorBox, Loading, useResource } from '../components';

export type AudienceFilters = { departments: string[]; roles: string[]; tags: string[] };
export const emptyFilters = (): AudienceFilters => ({ departments: [], roles: [], tags: [] });
export function AudienceFields({
  value,
  onChange,
}: {
  value: AudienceFilters;
  onChange: (v: AudienceFilters) => void;
}) {
  const options = useResource<AudienceFilters>('/broadcasts/audience-options');
  if (options.loading) return <Loading />;
  if (options.error || !options.data)
    return <ErrorBox message={options.error} retry={options.reload} />;
  return (
    <div className="audience-fields">
      <p className="muted small-text">
        เลือกหลายค่าในช่องเดียว = อย่างใดอย่างหนึ่ง · เลือกหลายช่อง = ต้องตรงทุกช่อง
        สังกัดและบทบาทใช้ข้อมูลจากการผูก CUSA ครั้งล่าสุด
      </p>
      <div className="audience-grid">
        {(
          [
            ['departments', 'สังกัด'],
            ['roles', 'บทบาท CUSA'],
            ['tags', 'ความสนใจที่เจ้าหน้าที่ระบุ'],
          ] as const
        ).map(([key, title]) => (
          <fieldset key={key}>
            <legend>{title}</legend>
            <div className="audience-options">
              {options.data![key].length ? (
                options.data![key].map((option) => (
                  <label key={option}>
                    <input
                      type="checkbox"
                      checked={value[key].includes(option)}
                      onChange={(e) =>
                        onChange({
                          ...value,
                          [key]: e.target.checked
                            ? [...value[key], option]
                            : value[key].filter((v) => v !== option),
                        })
                      }
                    />
                    <span>{option}</span>
                  </label>
                ))
              ) : (
                <span className="muted small-text">ยังไม่มีข้อมูล</span>
              )}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}
export function useAudiencePreview(segment: string, filters: AudienceFilters, enabled: boolean) {
  const key = JSON.stringify({ segment, filters });
  const [result, setResult] = useState<{ key: string; count: number | null; error: string } | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const timer = setTimeout(() => {
      post<{ count: number }>('/broadcasts/preview', JSON.parse(key))
        .then((data) => {
          if (active) setResult({ key, count: data.count, error: '' });
        })
        .catch((e) => {
          if (active) setResult({ key, count: null, error: (e as Error).message });
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, enabled]);
  return enabled && result?.key === key ? result : { count: null, error: '' };
}
export function AudienceSummary({ filters }: { filters?: Partial<AudienceFilters> }) {
  const groups = [filters?.departments, filters?.roles, filters?.tags].filter((a) => a?.length);
  return groups.length ? (
    <span className="audience-summary">{groups.map((a) => a!.join(' / ')).join(' · ')}</span>
  ) : null;
}
