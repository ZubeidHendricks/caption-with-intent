# Mutants

Deliberately broken implementations, each carrying one realistic bug.

A conformance suite that only ever runs against a correct implementation proves
nothing: it is self-consistent by construction. These exist so the suite is
tested on what it is for — detecting non-conformance — and each mutant is a
mistake a real implementer could plausibly make.

`npm run test:node` asserts that every mutant is caught, and names which vector
must catch it. If a mutant ever passes, the suite has a hole.
