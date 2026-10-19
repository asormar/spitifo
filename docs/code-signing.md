# Code signing the Windows installer

Windows SmartScreen warns about an unsigned installer ("Windows protected your
PC") until it has built reputation. Signing it with a certificate that chains to
a trusted root is what makes that warning go away over time. The Android APK is
already signed with the app's own key (a different mechanism).

## Options compared (checked 2026-10-18)

| Option | Cost | Can this project use it? |
| --- | --- | --- |
| **SignPath Foundation** (free for open source) | Free | Yes: public repository, MIT license, released, maintained by its owner. The certificate names "SignPath Foundation" as publisher. |
| **Azure Artifact Signing** (ex Trusted Signing) | About 10 USD a month | No: public-trust certificates go to organizations in the USA, Canada, the EU and the UK, and to individuals only in the USA and Canada. An individual in Spain does not qualify. |
| **A commercial OV certificate** | Roughly 200 to 400 USD a year | Technically yes, but since 2023 the key has to live on a hardware token or a cloud HSM, so CI signing needs an extra paid cloud signing service. EV certificates, which skip the reputation wait, are for companies. |

**Choice: SignPath Foundation.** It is the only free option that fits, and its
requirements match how the project already works (public repo, tagged releases
built in CI).

## Outcome: declined (2026-10-19)

The application was declined. SignPath Foundation looks for signs of public
trust that the project, 18 days old with no stars, forks or outside mentions, did
not have yet: community adoption, external articles or discussions, institutional
backing and sustained activity. It is not a judgment on the code, and they invite
a new application once the project is better known.

**Current state: releases ship unsigned.** Nothing breaks, and the signing steps
in `release.yml` stay off because `SIGNPATH_ORGANIZATION_ID` is not set. What is
left to choose from, when it is worth the money or the wait:

- **Reapply to the Foundation** after the project has some adoption.
- **A paid SignPath plan**, which they offered in the reply (price not checked:
  the pricing page was not reachable).
- **Certum's open source certificate**, from about 49 EUR a year for the cloud
  version. Its cloud signing asks for a one-time code from a phone app, which
  makes unattended CI signing awkward, and whether it counts for Windows
  Authenticode should be confirmed with Certum before paying.

The steps below apply as they are if the Foundation, or a paid SignPath plan,
is set up later.

## What SignPath asks for

From [signpath.org/terms](https://signpath.org/terms):

- OSI-approved license, no proprietary code, already released, actively
  maintained, functionality documented on the download page.
- Binaries built from source in an automated, verifiable build in the repository
  (the release workflow already does this; build scripts count as source).
- Multi-factor authentication for everybody on SignPath and on the repository.
- A "Code signing policy" section on the project home page with the required
  attribution, the team roles and a privacy statement (draft below).
- Product name equal to the project name, and the same version in every build.
- Every release is approved by hand in SignPath before it is signed.

## Steps

1. **Apply** at [signpath.org](https://signpath.org) for the OSS program with the
   repository URL. This is an account and an agreement, so it is yours to do.
   Turn on two-factor authentication on GitHub and on SignPath.
2. In SignPath: create the project (slug `spitifo`), a signing policy
   (`release-signing`, with manual approval), link the GitHub.com trusted build
   system, and import `.signpath/artifact-configurations/default.xml`. Create an
   API token for a submitter user.
3. In the repository settings add the secret `SIGNPATH_API_TOKEN` and the
   variable `SIGNPATH_ORGANIZATION_ID`.
4. Paste the policy below into the README.

`release.yml` already has the signing steps. They run only when the variable
`SIGNPATH_ORGANIZATION_ID` is set, so releases keep working unsigned until then.
When they run, the workflow waits for the approval in SignPath and replaces the
installer with the signed one before it is uploaded.

## Policy text for the README

> ### Code signing policy
>
> Free code signing provided by [SignPath.io](https://signpath.io), certificate
> by [SignPath Foundation](https://signpath.org).
>
> - **Author and approver:** Alejandro Sorolla ([@asormar](https://github.com/asormar)).
>   Every release is built by the `release` GitHub Actions workflow from a tag
>   and approved by hand before it is signed.
> - **Privacy:** Spitifo does not send data anywhere except to the sources and
>   storage the user picks. See the [privacy policy](PRIVACY.md).

## What is signed

The installer (`Spitifo-<version>-windows-x64-setup.exe`). The executables
inside it are not signed individually; that is not needed for SmartScreen and
would mean signing during the Tauri build.
