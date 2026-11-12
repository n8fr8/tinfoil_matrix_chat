# C2PA trust lists

The certificate lists `c2patool` uses to decide whether a Content Credentials
signer is trusted (`validation_state: "Trusted"` rather than `"Valid"`). They are
checked into the repo, rather than downloaded at build or run time, so each
release's attested image has a known, reviewable trust store and the bot needs no
network access to verify media.

| File | Source |
| --- | --- |
| `c2pa-trust-list.pem` | Official C2PA trust list (conformance program): https://raw.githubusercontent.com/c2pa-org/conformance-public/refs/heads/main/trust-list/C2PA-TRUST-LIST.pem |
| `c2pa-trust-list-legacy.pem` | Interim trust list (ITL) anchors, being retired: https://contentcredentials.org/trust/anchors.pem |
| `c2pa-trust-allowed.sha256.txt` | ITL allowed end-entity certificates: https://contentcredentials.org/trust/allowed.sha256.txt |
| `c2pa-trust-store.cfg` | Allowed certificate EKUs (written by `c2patool`) |

`c2patool --settings c2pa-trust/c2pa.toml <file>` loads these automatically from
this directory; `c2pa.toml` itself doesn't need to exist.

To refresh them (needs `c2patool` installed locally), run `npm run c2pa-trust`,
review the diff, and commit.
