import UIKit

/// Single-screen shell: Candy Call web app fills the phone.
final class MainTabBarController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let web = WebContainerViewController(service: .candyCall)
        let nav = UINavigationController(rootViewController: web)
        nav.setNavigationBarHidden(true, animated: false)
        nav.view.frame = view.bounds
        nav.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        addChild(nav)
        view.addSubview(nav.view)
        nav.didMove(toParent: self)
    }
}
