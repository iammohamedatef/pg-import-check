// Independently authored synthetic migrations; no third-party corpus content.
export const acceptanceCases = [
  {
    name: "clean",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY, label text NOT NULL);",
  },
  {
    name: "identity-default",
    sql: "CREATE TABLE public.t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, status text NOT NULL DEFAULT 'active', memo text);",
  },
  {
    name: "unique-check",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY, email text CONSTRAINT email_unique UNIQUE, amount numeric CONSTRAINT positive CHECK (amount > 0));",
  },
  {
    name: "self-fk",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY, parent_id integer CONSTRAINT parent_fk REFERENCES public.t(id));",
  },
  {
    name: "composite-types",
    sql: "CREATE TABLE public.t (a integer, b integer, payload jsonb, tags text[], PRIMARY KEY (a,b));",
  },
  {
    name: "staging",
    sql: "CREATE TABLE public.t (source_id text, payload text);",
  },
  {
    name: "orders",
    sql: "CREATE TABLE public.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY); CREATE TABLE public.t (id integer PRIMARY KEY, customer_id bigint NOT NULL REFERENCES public.customers(id), amount numeric NOT NULL CHECK (amount > 0), status text DEFAULT 'new');",
  },
  {
    name: "rls-policy",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY); ALTER TABLE public.t ENABLE ROW LEVEL SECURITY; CREATE POLICY insert_policy ON public.t FOR INSERT TO authenticated WITH CHECK (id > 0);",
  },
  {
    name: "trigger",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY); CREATE TRIGGER insert_guard BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.guard();",
  },
  {
    name: "add-column",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY); ALTER TABLE public.t ADD COLUMN required text NOT NULL;",
  },
  {
    name: "enum",
    sql: "CREATE TYPE public.state AS ENUM ('new','done'); CREATE TABLE public.t (id integer PRIMARY KEY, state public.state);",
  },
  {
    name: "generated",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY, amount numeric, total numeric GENERATED ALWAYS AS (amount * 2) STORED);",
  },
  {
    name: "non-public",
    sql: "CREATE TABLE reporting.t (id integer PRIMARY KEY);",
  },
  {
    name: "quoted",
    sql: 'CREATE TABLE public."Mixed Table" ("Key" integer PRIMARY KEY, "Status" text DEFAULT \'new\');',
  },
  {
    name: "drop-rename",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY); ALTER TABLE public.t RENAME COLUMN id TO new_id; DROP TABLE public.t;",
  },
  {
    name: "generated-fk",
    sql: "CREATE TABLE public.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY); CREATE TABLE public.t (id integer PRIMARY KEY, customer_id bigint REFERENCES public.customers(id));",
  },
  {
    name: "mixed-dml",
    sql: "CREATE TABLE public.t (id integer PRIMARY KEY); INSERT INTO public.t VALUES (1); UPDATE public.t SET id = 2; DELETE FROM public.t;",
  },
  {
    name: "large",
    sql: `CREATE TYPE public.import_state AS ENUM ('new', 'accepted', 'held');
${Array.from({ length: 300 }, (_, i) => `CREATE TABLE public.obj_${i} (id integer PRIMARY KEY, memo text, source_code text UNIQUE);`).join("\n")}
CREATE TABLE public.t (id integer PRIMARY KEY, obj_id integer REFERENCES public.obj_1(id),
  state public.import_state DEFAULT 'new', amount numeric NOT NULL CHECK (amount >= 0));
CREATE UNIQUE INDEX t_identity ON public.t (id, obj_id);
ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
CREATE POLICY t_insert ON public.t FOR INSERT TO authenticated WITH CHECK (true);
CREATE TRIGGER t_guard BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.guard();
CREATE FUNCTION public.guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
INSERT INTO public.t (id, amount) VALUES (1, 0);
ALTER TABLE public.t OWNER TO postgres;
ALTER TABLE public.t ADD COLUMN future_value text;`,
  },
] as const;
