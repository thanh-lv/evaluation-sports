import Foundation

/// Catalog text in both app languages (`{vi, en}`); follows the UI language, not the narrative language.
public struct LocalizedText: Codable, Sendable, Hashable {
    public var vi: String
    public var en: String

    public init(vi: String, en: String) {
        self.vi = vi
        self.en = en
    }

    public func text(for language: Language) -> String {
        switch language {
        case .vi: return vi
        case .en: return en
        }
    }
}

/// A list of lines in both app languages (drill steps).
public struct LocalizedList: Codable, Sendable, Hashable {
    public var vi: [String]
    public var en: [String]

    public init(vi: [String], en: [String]) {
        self.vi = vi
        self.en = en
    }

    public func lines(for language: Language) -> [String] {
        switch language {
        case .vi: return vi
        case .en: return en
        }
    }
}
