-- 0123 — one and a half inches is one and a half inches, however it is printed.
--
-- Turf-Ag print the Emjay male adaptor as 40MM X 11/2", BlueWave as
-- 40MM X 1 1/2". Both mean 1½ inch. match_sizes read the first as the
-- numbers 11 and 2 and the second as 1 and 2, so the two were "different
-- sizes" and the second supplier's adaptor was never offered against the
-- first's — the same thing twice in the catalogue again.
--
-- match_fractions writes an inch fraction as a decimal before anything is
-- compared: "1 1/2", "1-1/2", "11/2" and "1½" are all 1.5; "3/4" is 0.75.
-- Only a fraction of an inch — a denominator of 2, 4, 8, 16, 32 or 64, the
-- numerator smaller — and "11/2" only as one digit before a one-digit
-- numerator. Everything else keeps its slash: over every name and
-- description in both shops that has one, "SABS 657/1", "32/40MM" and
-- "12/24" stay as they are.
--
-- It runs inside match_norm, after 0122's tail, so it applies to both sides
-- of every comparison. Names and descriptions themselves are not changed.

create function public.match_fractions(p text) returns text
language plpgsql immutable set search_path = public, extensions as $$
declare
  v text; m text[]; w numeric;
  -- An inch fraction's denominators. Nothing else is read as a fraction.
  c_den constant int[] := array[2, 4, 8, 16, 32, 64];
  -- A slash that is not a fraction is set aside under this while the rest
  -- are read, so one "12/24" does not stop a "3/4" after it being seen.
  c_kept constant text := chr(1);
begin
  if p is null then return null; end if;
  v := replace(replace(replace(p, '½', ' 1/2'), '¼', ' 1/4'), '¾', ' 3/4');

  -- "1 1/2", "1-1/2": a whole number and a fraction, apart.
  loop
    m := regexp_match(v, '(^|[^0-9./])(\d+)[ -]+(\d+)/(\d+)(?![0-9./])');
    exit when m is null;
    if m[4]::int = any(c_den) and m[3]::int < m[4]::int then
      w := m[2]::numeric + m[3]::numeric / m[4]::int;
      v := regexp_replace(v, '(^|[^0-9./])(\d+)[ -]+(\d+)/(\d+)(?![0-9./])', '\1' || trim_scale(w)::text);
    else
      v := regexp_replace(v, '(^|[^0-9./])(\d+)([ -]+)(\d+)/(\d+)(?![0-9./])', '\1\2\3\4' || c_kept || '\5');
    end if;
  end loop;
  v := replace(v, c_kept, '/');

  -- "11/2", "13/4": the same, printed without the space, as Turf-Ag print
  -- it. One digit before a one-digit numerator smaller than its denominator.
  loop
    m := regexp_match(v, '(^|[^0-9./])(\d)(\d)/([2468])(?![0-9./])');
    exit when m is null;
    if m[4]::int = any(c_den) and m[3]::int < m[4]::int then
      w := m[2]::numeric + m[3]::numeric / m[4]::int;
      v := regexp_replace(v, '(^|[^0-9./])(\d)(\d)/([2468])(?![0-9./])', '\1' || trim_scale(w)::text);
    else
      v := regexp_replace(v, '(^|[^0-9./])(\d)(\d)/([2468])(?![0-9./])', '\1\2\3' || c_kept || '\4');
    end if;
  end loop;
  v := replace(v, c_kept, '/');

  -- "3/4", "1/2": a fraction on its own.
  loop
    m := regexp_match(v, '(^|[^0-9./])(\d+)/(\d+)(?![0-9./])');
    exit when m is null;
    if m[3]::int = any(c_den) and m[2]::int < m[3]::int then
      v := regexp_replace(v, '(^|[^0-9./])(\d+)/(\d+)(?![0-9./])',
             '\1' || trim_scale(m[2]::numeric / m[3]::int)::text);
    else
      v := regexp_replace(v, '(^|[^0-9./])(\d+)/(\d+)(?![0-9./])', '\1\2' || c_kept || '\3');
    end if;
  end loop;
  return replace(v, c_kept, '/');
end;
$$;
revoke execute on function public.match_fractions(text) from public, anon, authenticated;

create or replace function public.match_norm(p text) returns text
language sql immutable set search_path = public, extensions as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(coalesce(public.match_fractions(public.match_without_tail(p)), '')),
                '(\d),(\d)', '\1.\2', 'g'),
              '(\d)\s*(litres|litre|liters|liter|ltrs|ltr|lt|l)\y', '\1l', 'g'),
            '(\d)\s*(mtrs|mtr|mt)\y', '\1m', 'g'),
          '(\d)\s*(mm|cm|ml|mic|kg|m|g|w)\y', '\1\2', 'g'),
        '(\d)\s*[x×*]\s*(?=\d)', '\1 x ', 'g'),
      '[^a-z0-9./ ]', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;
