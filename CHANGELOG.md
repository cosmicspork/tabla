# Changelog

## [0.5.0](https://github.com/cosmicspork/tabla/compare/v0.4.1...v0.5.0) (2026-08-22)


### Features

* **app:** read a code with the camera, on the platform that needs it most ([#28](https://github.com/cosmicspork/tabla/issues/28)) ([5f124f5](https://github.com/cosmicspork/tabla/commit/5f124f5350d9345ac22b2cd7b27bbb11b39125c8))

## [0.4.1](https://github.com/cosmicspork/tabla/compare/v0.4.0...v0.4.1) (2026-08-21)


### Bug Fixes

* **app:** stop a link being spent in the browser it landed in ([#26](https://github.com/cosmicspork/tabla/issues/26)) ([e44c4d5](https://github.com/cosmicspork/tabla/commit/e44c4d5d40394e52aff0063464695dec28ea9c35))

## [0.4.0](https://github.com/cosmicspork/tabla/compare/v0.3.0...v0.4.0) (2026-08-21)


### Features

* **app:** claim the turn, and take back a move that lost the race ([#23](https://github.com/cosmicspork/tabla/issues/23)) ([dfa43dc](https://github.com/cosmicspork/tabla/commit/dfa43dc43548e083de73700ea7a8e7a8df0efdfe))
* **app:** link a second device and keep both in step ([#22](https://github.com/cosmicspork/tabla/issues/22)) ([357a537](https://github.com/cosmicspork/tabla/commit/357a5376c3660595f0ae8b464e963a4f0ff58586))
* **core:** devices, their mailboxes, and a hold on the turn ([#20](https://github.com/cosmicspork/tabla/issues/20)) ([a3d0ce9](https://github.com/cosmicspork/tabla/commit/a3d0ce943cdc61c538c8df33ee9cfd2ba60e7c5f))
* **relay:** device links, turn holds, and push per device ([#21](https://github.com/cosmicspork/tabla/issues/21)) ([820a0e8](https://github.com/cosmicspork/tabla/commit/820a0e82a91f62aeba39db9dfb791f6e5b796086))


### Bug Fixes

* **backup:** carry the display name across a device move ([#17](https://github.com/cosmicspork/tabla/issues/17)) ([b2c06ff](https://github.com/cosmicspork/tabla/commit/b2c06ff04339c67b3b7e6bc28b1f2016fb33351c))
* harden restore and sync edge cases ([#25](https://github.com/cosmicspork/tabla/issues/25)) ([debeb91](https://github.com/cosmicspork/tabla/commit/debeb91d9b4c409a9df12f2fbfa0d8fff1cd91c7))

## [0.3.0](https://github.com/cosmicspork/tabla/compare/v0.2.0...v0.3.0) (2026-08-20)


### Features

* **app:** give settings a shape, and the app a mark ([#13](https://github.com/cosmicspork/tabla/issues/13)) ([a8fe8c6](https://github.com/cosmicspork/tabla/commit/a8fe8c6186686b7772ca93ab6570ac84e6e3d54c))
* **app:** sort the game list by who has to move next ([#12](https://github.com/cosmicspork/tabla/issues/12)) ([b761c05](https://github.com/cosmicspork/tabla/commit/b761c05aef0f0b468a93eaf78d625364d602d7fa))
* let people have names, and start a game by choosing one ([#14](https://github.com/cosmicspork/tabla/issues/14)) ([e06fbe9](https://github.com/cosmicspork/tabla/commit/e06fbe920e02706415e6e04244b578fb8c6e035b))
* **letras:** check words as they are played, and drop the challenge ([#16](https://github.com/cosmicspork/tabla/issues/16)) ([6928135](https://github.com/cosmicspork/tabla/commit/692813533672c3bfdba417d095a8a3c7ff25f024))
* **relay:** invite someone you have played, without sending them anything ([#15](https://github.com/cosmicspork/tabla/issues/15)) ([4fdeaca](https://github.com/cosmicspork/tabla/commit/4fdeacae5dbbbbce14cfaf134d85430358e45109))
* **relay:** let an invite be withdrawn before anyone takes it ([#11](https://github.com/cosmicspork/tabla/issues/11)) ([db7fed2](https://github.com/cosmicspork/tabla/commit/db7fed24f011674e9d42d7a06f649360be567b10))


### Bug Fixes

* **app:** give every screen a header, and say what is happening at the top ([#10](https://github.com/cosmicspork/tabla/issues/10)) ([277bf34](https://github.com/cosmicspork/tabla/commit/277bf341e42f41e36d95654ce2fbac55a7c7fbaf))
* **worker:** give push a real contact instead of a placeholder ([58f0a1d](https://github.com/cosmicspork/tabla/commit/58f0a1d7aaa8d093e1bbc085a408c2fc0a8b1624))

## [0.2.0](https://github.com/cosmicspork/tabla/compare/v0.1.0...v0.2.0) (2026-08-20)


### Features

* **app:** a game registry, a picker, and per-game boards ([2c92dad](https://github.com/cosmicspork/tabla/commit/2c92dadc98883b093aa0b538bf78b2b568b27321))
* **app:** game list, invite sharing, board, and the plugin sandbox ([f48e0f2](https://github.com/cosmicspork/tabla/commit/f48e0f2ec85525da9dd32787e7daa5b988a4fe8a))
* **app:** play a game dealt from a real deck ([4a6b567](https://github.com/cosmicspork/tabla/commit/4a6b567d0d3b39a02f9eb16144383c2173132fc5))
* **app:** the word board, and browser tests that play on it ([2d3f71d](https://github.com/cosmicspork/tabla/commit/2d3f71da48231aa57f638cb3c89f203fd67513b2))
* **backup:** encrypted export and device migration ([6e9f28f](https://github.com/cosmicspork/tabla/commit/6e9f28fde4728746a5a376e048532b88d43c41e4))
* **build:** commit a letras-only plugin module ([e2b2604](https://github.com/cosmicspork/tabla/commit/e2b2604228c70a643baa1a4b8ac3bcb433d52ca7))
* **core:** derive per-game draw entropy from the identity key ([498f3fe](https://github.com/cosmicspork/tabla/commit/498f3feec46a657d2507c40d8c287d4f9e906d9b))
* **core:** identity, key agreement, sealing, invites, and encrypted export ([a47c6f5](https://github.com/cosmicspork/tabla/commit/a47c6f585734ec7999b0f9886fdd3757e030f880))
* **core:** signed hash-chained game log with tombstone rollback protection ([3e8a849](https://github.com/cosmicspork/tabla/commit/3e8a849500aeabb34334938287ef553e0ab41a68))
* **dawg:** a compact static word list ([5c87e2e](https://github.com/cosmicspork/tabla/commit/5c87e2ec967f0c6e6f25bf0729805e4fdf2f2d83))
* **deal:** a verifiable shuffle ([e31d6bd](https://github.com/cosmicspork/tabla/commit/e31d6bdbf1badedabaf5a549a8520e3ca90ebb6a))
* **deal:** the deal as a state machine ([e4c2ed4](https://github.com/cosmicspork/tabla/commit/e4c2ed48828c52639c522d2aa60732eba287d67c))
* **deal:** threshold ElGamal, Schnorr proofs, and a bound transcript ([898b9ee](https://github.com/cosmicspork/tabla/commit/898b9eef4f1d7c23a578849775e3eab3b13969b1))
* **dict:** vendor ENABLE and commit the compiled dictionary ([7e2a578](https://github.com/cosmicspork/tabla/commit/7e2a578e3b40dcac678c4622170206e4e677f7d0))
* **letras:** board, tile set, placement and scoring ([aa71592](https://github.com/cosmicspork/tabla/commit/aa715920812233e4978ef40c931187d475b50c0c))
* **letras:** challenges, and the reckoning at the end ([1c419bb](https://github.com/cosmicspork/tabla/commit/1c419bb91b1e257614f495f9c56b81d913e31370))
* **letras:** private draw streams with committed racks ([e50e169](https://github.com/cosmicspork/tabla/commit/e50e1694c5ec9900f0fd1b93f6edff4884f9c7fb))
* **letras:** rules for a game dealt from a real deck ([4716cb1](https://github.com/cosmicspork/tabla/commit/4716cb166f57191bf8b0df5e2ee895b46058a7b1))
* **manifest:** sign the list of plugin modules a build will run ([fe01bcc](https://github.com/cosmicspork/tabla/commit/fe01bcceae80f384bacafd998c16b1456901d702))
* one encrypted deck, dealt by mental poker ([76e0376](https://github.com/cosmicspork/tabla/commit/76e037668f4281ec6ac4543e574504900d135086))
* plugin distribution — downloadable, removable, signed ([6c73c06](https://github.com/cosmicspork/tabla/commit/6c73c063743dd50bba32be49957ee42ccfe69f4e))
* **plugin-api:** thread an assets parameter through the plugin interface ([418cc1b](https://github.com/cosmicspork/tabla/commit/418cc1bc68735555adcd2d0a1441879dfa827b8c))
* **plugin-wasm:** gate bundled games behind cargo features ([2921fec](https://github.com/cosmicspork/tabla/commit/2921fec394cf9a4547d150e572ac0e4c9480de50))
* **plugin-wasm:** register letras alongside tic tac toe ([98be8d9](https://github.com/cosmicspork/tabla/commit/98be8d9570a40a1399244b63a5b1b4502bdf3810))
* **plugin:** pure-function game plugin interface and tic tac toe ([d700d58](https://github.com/cosmicspork/tabla/commit/d700d5865de2caa4657e9e6ba5b2536b00ce8603))
* **plugin:** ship two versions of the word game at once ([b980542](https://github.com/cosmicspork/tabla/commit/b980542e996dc00aad9437f394823128d0841ee0))
* **plugin:** unbundle letras ([f7561ec](https://github.com/cosmicspork/tabla/commit/f7561ecc19b2351eef79b586be4dc00311bcfcc6))
* **pwa:** offline shell, install walkthrough, and content-free push ([902f9da](https://github.com/cosmicspork/tabla/commit/902f9da59cbd522de1ca6d22dfb0b47bc32be3ac))
* **relay:** invite and game-room Durable Objects with retention tombstones ([7ca530c](https://github.com/cosmicspork/tabla/commit/7ca530c268d61d6cfcd99443ad45950389ef5f04))
* **sandbox:** let the worker be handed rules it does not carry ([bf2ea28](https://github.com/cosmicspork/tabla/commit/bf2ea289c0f83d026a10ff89a353af0aea343eda))
* **settings:** manage the games kept on this device ([d416314](https://github.com/cosmicspork/tabla/commit/d416314c527c12d99922a7afac2c569243ad3701))
* **storage:** keep downloaded games in the database, not a cache ([94b9f7f](https://github.com/cosmicspork/tabla/commit/94b9f7f703ffcc3f1cd125ceb624163eb7c0aa5d))
* **sync:** hibernating WebSocket sync with two-client integration test ([a5ad332](https://github.com/cosmicspork/tabla/commit/a5ad3329a4832bbcfae5df6194bbfc4e4ef7cbdc))
* **sync:** tell each player when the other is here ([ad34269](https://github.com/cosmicspork/tabla/commit/ad342696d8567f3e3776d2175e9537e5b92910c0))
* **wasm:** expose the deal to the app ([4bf5450](https://github.com/cosmicspork/tabla/commit/4bf5450368c9f168065584e52064bc1baa5e87de))
* **wasm:** split core and plugin into separate WASM modules with TS loaders ([8794f0f](https://github.com/cosmicspork/tabla/commit/8794f0fc70d9c7b0d6ecc675aed0970621bd511b))


### Bug Fixes

* **ci:** do not deploy just because the release workflow was dispatched ([917fda1](https://github.com/cosmicspork/tabla/commit/917fda15f1d478f8ba0a7a28474f519824dc60ac))
* **ci:** do not deploy just because the release workflow was dispatched ([7d8a5e8](https://github.com/cosmicspork/tabla/commit/7d8a5e8b8b06e8af02b187ba631b256e62aef817))
