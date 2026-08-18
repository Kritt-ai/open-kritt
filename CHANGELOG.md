# Changelog

## [1.4.1](https://github.com/Kritt-ai/open-kritt/compare/v1.4.0...v1.4.1) (2026-08-16)


### Bug Fixes

* ranker didn't actually used the user provided ranking rules ([3f4a15c](https://github.com/Kritt-ai/open-kritt/commit/3f4a15c43caa6a6f1e7c45f2570daadc05ae1b8e))

## [1.4.0](https://github.com/Kritt-ai/open-kritt/compare/v1.3.0...v1.4.0) (2026-08-12)


### Features

* **accounts:** show Codex reset-credit expirations ([8168411](https://github.com/Kritt-ai/open-kritt/commit/8168411e70113463490c45f0ea1036db28b01164))
* added steps binding feature ([81b6367](https://github.com/Kritt-ai/open-kritt/commit/81b63673a9f4e94ee204ef395ed028af788d3a15))
* create kritt-headless runner for remote machines ([8e8dd60](https://github.com/Kritt-ai/open-kritt/commit/8e8dd60ae28446cb00ed8de76c5fa0231cadcce3))
* **engine:** add deterministic resume ordering controls ([4be52c8](https://github.com/Kritt-ai/open-kritt/commit/4be52c86ba8d3255ac8bb390e31ba21b6468d52e))
* **engine:** add memory-aware runner admission ([7f47690](https://github.com/Kritt-ai/open-kritt/commit/7f47690b3f26054dc0858f483710a1151fd7d429))
* **engine:** add memory-aware runner controls ([297fc93](https://github.com/Kritt-ai/open-kritt/commit/297fc93f5b36745a1da2a683043fa9da381b0a35))
* export completed scan findings ([36a4685](https://github.com/Kritt-ai/open-kritt/commit/36a4685a6a6ff6ee58b5a446351fc130b0c62ad0))
* **frontend:** add community star support ([#58](https://github.com/Kritt-ai/open-kritt/issues/58)) ([3597248](https://github.com/Kritt-ai/open-kritt/commit/3597248077c906ecbb8a0d2c72dcb2673d1ad9a9))


### Bug Fixes

* allow partial exports for scans ([078147f](https://github.com/Kritt-ai/open-kritt/commit/078147f1f3b917d7384fbfe56e111ac0d199d254))
* **compose:** persist checkout cache and restart engine ([a20eed5](https://github.com/Kritt-ai/open-kritt/commit/a20eed5bcf804990bab9614ae7722d6d72f04d14))
* editting existing workflow should duplicate ([d4df519](https://github.com/Kritt-ai/open-kritt/commit/d4df519252ec410fa352b48e02eea28e87f78578))
* **engine:** retry quota-limited scans sooner ([9b817ed](https://github.com/Kritt-ai/open-kritt/commit/9b817ede36bc5637427ec57d7826b9810ebd1ec0))
* **engine:** validate Codex CLI installations ([9d7f658](https://github.com/Kritt-ai/open-kritt/commit/9d7f6588171f5fcbc950c526313e593d993ce424))
* **engine:** validate Codex CLI installations ([b8489ce](https://github.com/Kritt-ai/open-kritt/commit/b8489ce5dfefa0391c0db9494a7adf805d803079))
* **export:** bound findings archive resources ([b2cfc5b](https://github.com/Kritt-ai/open-kritt/commit/b2cfc5be39dff1ad928bf03042eaa2532e20a718))
* **frontend:** allow concurrent account quota starts ([92c53ec](https://github.com/Kritt-ai/open-kritt/commit/92c53ec2f34e9f7c7de3205cd5b5f626783a2614))
* **frontend:** allow concurrent account quota starts ([43086b3](https://github.com/Kritt-ai/open-kritt/commit/43086b38dc0cc6d8207ea21b4e515a6888d4eabb))
* **frontend:** render real required vulnerability key count on terminal step ([51719c6](https://github.com/Kritt-ai/open-kritt/commit/51719c67bc206809fcbd1304071fc411a89d2794))
* **frontend:** render real required vulnerability key count on terminal step ([bb62f50](https://github.com/Kritt-ai/open-kritt/commit/bb62f50fa5e7c5a56252502b7d48e9197700c723)), closes [#57](https://github.com/Kritt-ai/open-kritt/issues/57)

## [1.3.0](https://github.com/Kritt-ai/open-kritt/compare/v1.2.0...v1.3.0) (2026-08-04)


### Features

* ENGINE_IGNORE_LOW_STORAGE advance settings for users who don't care about filling the host disk ([9c117e8](https://github.com/Kritt-ai/open-kritt/commit/9c117e87b70b235081976b3fb514ea6fb928b77b))
* **frontend:** add community links ([d973ab8](https://github.com/Kritt-ai/open-kritt/commit/d973ab87d16a004df5f4e1dd382b7673851739fa))
* **frontend:** add privacy-safe sharing loop ([#54](https://github.com/Kritt-ai/open-kritt/issues/54)) ([27f2f48](https://github.com/Kritt-ai/open-kritt/commit/27f2f485daa44ec13c131736279ccb29abe23600))
* **frontend:** improve active worker status ([046d90a](https://github.com/Kritt-ai/open-kritt/commit/046d90a5a3c5f0ec349377a3908d729f8839e801))
* **frontend:** improve active worker status ([407dd92](https://github.com/Kritt-ai/open-kritt/commit/407dd92762ecfe70d865fa90516ae7ba170d6af1))
* harden scan runtime and account handling ([d6aea21](https://github.com/Kritt-ai/open-kritt/commit/d6aea212fd041e2b9bf654c56366355d8be54ab3))
* harden scan runtime and account handling ([39091e2](https://github.com/Kritt-ai/open-kritt/commit/39091e2929eb077a92ef3cf27ab151b6e8ec1c24))
* scale provider accounts and scan processing ([266a969](https://github.com/Kritt-ai/open-kritt/commit/266a969eef0221075b4a182ddc2f7006eeed7509))
* scale provider accounts and scan processing ([7828800](https://github.com/Kritt-ai/open-kritt/commit/7828800079323309b15a6f734093ca9da258d300))
* show active worker model and harness ([7c146dc](https://github.com/Kritt-ai/open-kritt/commit/7c146dcff539746d259b29a4542b6638c776cd2c))
* support separate post-processing models ([1e3b703](https://github.com/Kritt-ai/open-kritt/commit/1e3b7036523953c28e583e88c19d5b01461c515a))
* support separate post-processing models ([15a0630](https://github.com/Kritt-ai/open-kritt/commit/15a0630d34866bde7421e8db97f62ac72924bbab))


### Bug Fixes

* **cli:** keep setup menu options visible on short terminals ([f2965c7](https://github.com/Kritt-ai/open-kritt/commit/f2965c723ba18664107a266b454193bf464741a2))
* **cli:** keep setup menu options visible on short terminals ([90be056](https://github.com/Kritt-ai/open-kritt/commit/90be0567dd5ae80b8f3f05a249f16462f64c6912))
* fixed Report Creator post script confusing prompt expanded context ([0a480d8](https://github.com/Kritt-ai/open-kritt/commit/0a480d8ca9211e7db0317072113286cb07a24faf))
* **frontend:** sanitize markdown link hrefs to block javascript: URIs ([6c5c829](https://github.com/Kritt-ai/open-kritt/commit/6c5c8290a2b4c9911a62995a337986d9a69ffef4))
* improved aggresive share requests to be more subtle ([c5a783b](https://github.com/Kritt-ai/open-kritt/commit/c5a783b9a53f7f8729fc90f26dacae8213d89b5e))

## [1.2.0](https://github.com/Kritt-ai/open-kritt/compare/v1.1.0...v1.2.0) (2026-07-23)


### Features

* added malicious actor in findings view ([7bc3dbc](https://github.com/Kritt-ai/open-kritt/commit/7bc3dbc1656113db3c3e41ce79e27015a3f928ed))
* added model per scan depth selection ([f50c46e](https://github.com/Kritt-ai/open-kritt/commit/f50c46eb85578817c11d708333ec85bd562df6e6))


### Bug Fixes

* added file count when using local repos and search when looking up skills in a scan ([adf6e9e](https://github.com/Kritt-ai/open-kritt/commit/adf6e9ed6ac2a767af71c9f0a0fb1c54f0e9680a))
* added unused workflow deletion and model catalog for open router ([8f1ae00](https://github.com/Kritt-ai/open-kritt/commit/8f1ae0069443adffd651b76db8cff3485573afa9))
* edit model ui crash issue fix ([545e0ed](https://github.com/Kritt-ai/open-kritt/commit/545e0ed4686d7bf66d9ad31e64e905e1653f94a4))
* fixed scan model update issue ([5644f7a](https://github.com/Kritt-ai/open-kritt/commit/5644f7aca73eada9e60ab0459c917df7d0005263))

## [1.1.0](https://github.com/Kritt-ai/open-kritt/compare/v1.0.0...v1.1.0) (2026-07-20)


### Features

* changed resource_exhaustion to _chip_resource_exhaustion ([7015525](https://github.com/Kritt-ai/open-kritt/commit/7015525aa6832bc660c050017e3750aa068c11b3))
* changed resource_exhaustion to _chip_resource_exhaustion ([be89c98](https://github.com/Kritt-ai/open-kritt/commit/be89c9883d827191e70710f0de897e30e5722140))
* first open-source commit ([f0c939d](https://github.com/Kritt-ai/open-kritt/commit/f0c939de7e83a22a4606431c702eb9be75491694))

## [1.0.0](https://github.com/Kritt-ai/open-kritt/compare/v0.4.8...v1.0.0) (2026-07-15)


### Features

* initial public commit ([8210dcf](https://github.com/Kritt-ai/open-kritt/commit/8210dcf1c4e180e2da6b583fe93cdf41dac5c06b))


### Miscellaneous Chores

* prepare 1.0.0 release ([b2ef048](https://github.com/Kritt-ai/open-kritt/commit/b2ef048e8b171e8e990b952f2b8ca148b7f1ee6a))

## Changelog

All notable changes to open·kritt are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, see [RELEASE.md](RELEASE.md) for the stability policy.
