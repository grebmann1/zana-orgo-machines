# Third-party development dependency

`vendor/zana-ai-zcc-plugin-sdk-0.1.0.tgz` contains the Zana plugin SDK 0.1.0, distributed under the MIT license. Its source is [salesforce/zana, packages/plugin-sdk](https://github.com/salesforce/zana/tree/main/packages/plugin-sdk). The copyright and permission notice is preserved in [vendor/LICENSE-zcc-plugin-sdk.txt](vendor/LICENSE-zcc-plugin-sdk.txt).

The SDK archive makes the test harness reproducible without a private package registry. It is used for development and tests. Zana provides the SDK and React runtime when installing the plugin. The generated declarations in `types/` are also from that SDK.
