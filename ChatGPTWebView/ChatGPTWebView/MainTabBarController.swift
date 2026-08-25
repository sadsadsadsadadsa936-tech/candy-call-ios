import UIKit

/// Single-screen shell: Candy Call fills the phone edge-to-edge.
final class MainTabBarController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.03, green: 0.035, blue: 0.05, alpha: 1)

        let web = WebContainerViewController(service: .candyCall)
        web.view.frame = view.bounds
        web.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        addChild(web)
        view.addSubview(web.view)
        web.didMove(toParent: self)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}
