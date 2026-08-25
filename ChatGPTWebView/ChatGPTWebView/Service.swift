import Foundation

struct InjectedJavaScript {
    let documentStart: String?
    let documentEnd: String?
    let didFinish: String?
}

enum Service: CaseIterable {
    case candyCall

    /// Local bundled UI (no Cloudflare website).
    var localIndexURL: URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www")
            ?? Bundle.main.url(forResource: "index", withExtension: "html")
    }

    var homeURL: URL {
        localIndexURL ?? URL(string: "https://candy-hosting.com/candy-call/")!
    }

    var usesLocalBundle: Bool { localIndexURL != nil }

    var title: String { "Candy Call" }

    var tabIconSystemName: String { "phone.fill" }

    var userAgentOverride: String? {
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }

    var injectedJavaScript: InjectedJavaScript? {
        InjectedJavaScript(
            documentStart: """
            window.CANDY_CALL_CONFIG = {
              apiBase: 'http://5.175.192.242:3855',
              native: true
            };
            """,
            documentEnd: nil,
            didFinish: nil
        )
    }

    var zoomDefaultsKey: String { "zoomScale.candyCall" }

    var websiteDataDomain: String { "candy-hosting.com" }
}
