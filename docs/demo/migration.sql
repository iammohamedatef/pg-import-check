-- Independently authored synthetic example. No customer data or schema.
CREATE TYPE public.contact_status AS ENUM ('active', 'archived');
CREATE TABLE public.contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  display_name text,
  status public.contact_status NOT NULL DEFAULT 'active',
  created_at timestamp with time zone DEFAULT now()
);
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_email_unique UNIQUE (email);

CREATE TABLE public.teams (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);
