import Foundation

struct InjectedJavaScript {
    let documentStart: String?
    let documentEnd: String?
    let didFinish: String?
}

enum Service: CaseIterable {
    case candyCall

    var homeURL: URL {
        URL(string: "https://candy-hosting.com/candy-call/")!
    }

    var title: String { "Candy Call" }

    var tabIconSystemName: String { "phone.fill" }

    var userAgentOverride: String? {
        // Mobile Safari UA so WebRTC / getUserMedia behave like Safari
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }

    var injectedJavaScript: InjectedJavaScript? { nil }

    var zoomDefaultsKey: String { "zoomScale.candyCall" }

    var websiteDataDomain: String { "candy-hosting.com" }
}
