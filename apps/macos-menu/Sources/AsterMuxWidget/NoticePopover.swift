import AppKit

/// Anchored popover used for transient notices (success / error) from the
/// menu bar item. Replaces NSAlert — non-modal, dismisses on outside click,
/// renders with a system blur background so it feels like native macOS HUDs.
final class NoticePopover {
    enum Kind {
        case success
        case failure

        var tint: NSColor {
            switch self {
            case .success: return .systemGreen
            case .failure: return .systemRed
            }
        }

        var symbol: String {
            switch self {
            case .success: return "\u{2714}"
            case .failure: return "\u{26A0}"
            }
        }
    }

    private weak var anchorView: NSView?
    private var popover: NSPopover?
    private var dismissTimer: Timer?

    init(anchorView: NSView?) {
        self.anchorView = anchorView
    }

    func show(title: String, detail: String?, kind: Kind, autoDismiss: TimeInterval? = nil) {
        guard let anchor = anchorView else { return }
        dismiss()
        let pop = NSPopover()
        pop.behavior = .transient
        pop.animates = true
        pop.contentViewController = NoticeViewController(
            title: title,
            detail: detail,
            kind: kind
        )
        pop.show(
            relativeTo: anchor.bounds,
            of: anchor,
            preferredEdge: .minY
        )
        popover = pop
        if let ttl = autoDismiss {
            dismissTimer = Timer.scheduledTimer(
                withTimeInterval: ttl,
                repeats: false
            ) { [weak self] _ in
                self?.dismiss()
            }
        }
    }

    func dismiss() {
        dismissTimer?.invalidate()
        dismissTimer = nil
        popover?.performClose(nil)
        popover = nil
    }
}

private final class NoticeViewController: NSViewController {
    private let titleText: String
    private let detailText: String?
    private let kind: NoticePopover.Kind

    init(title: String, detail: String?, kind: NoticePopover.Kind) {
        self.titleText = title
        self.detailText = detail
        self.kind = kind
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let backing = NSVisualEffectView(frame: .zero)
        backing.material = .hudWindow
        backing.state = .active
        backing.blendingMode = .behindWindow
        backing.wantsLayer = true
        backing.layer?.cornerRadius = 10

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let header = NSTextField(labelWithString: "\(kind.symbol)  \(titleText)")
        header.font = .systemFont(ofSize: 13, weight: .semibold)
        header.textColor = kind.tint
        stack.addArrangedSubview(header)

        if let detail = detailText, !detail.isEmpty {
            let body = NSTextView()
            body.string = detail
            body.isEditable = false
            body.isSelectable = true
            body.drawsBackground = false
            body.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
            body.textColor = .secondaryLabelColor
            body.textContainerInset = NSSize(width: 0, height: 0)

            let scroll = NSScrollView()
            scroll.hasVerticalScroller = true
            scroll.drawsBackground = false
            scroll.borderType = .noBorder
            scroll.documentView = body
            scroll.translatesAutoresizingMaskIntoConstraints = false
            scroll.heightAnchor.constraint(
                lessThanOrEqualToConstant: 220
            ).isActive = true
            scroll.widthAnchor.constraint(
                greaterThanOrEqualToConstant: 360
            ).isActive = true
            stack.addArrangedSubview(scroll)
        }

        backing.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: backing.topAnchor),
            stack.leadingAnchor.constraint(equalTo: backing.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: backing.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: backing.bottomAnchor),
        ])
        self.view = backing
        self.preferredContentSize = NSSize(width: 400, height: detailText == nil ? 50 : 200)
    }
}
