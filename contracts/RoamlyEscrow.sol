// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title RoamlyEscrow
/// @notice Holds a buyer's payment for an item a traveler carries home, until delivery.
///         There is no owner, admin or arbiter: nobody can move a deal's funds except
///         by the rules below. The only cut is a fixed fee on what the traveler is paid.
///
/// Marketplace data lives here too, so every user sees the same trips and requests:
///   - travelers listTrip (city code, date, capacity, accepted categories, notes) and can closeTrip
///   - anyone can setName (a display name for their wallet)
///   - createDeal is a request on a trip, with the item details; the contract enforces the trip's
///     capacity, its categories and Turkey's €430 personal allowance per trip (requests that end in
///     a refund free their slot and allowance again)
///
/// Flow:
///   buyer createDeal ─▶ Funded ─ traveler accept ─▶ Accepted ─ traveler markDelivered ─▶ Delivered
///     Funded:    buyer cancel / traveler decline / deadline passes      → buyer refunded
///     Accepted:  buyer confirmDelivery                                  → traveler paid
///                deliverBy passes without delivery                      → buyer can claim refund
///     Delivered: buyer confirmDelivery, or 7 days pass                  → traveler paid
///     Accepted/Delivered: traveler enters the buyer's delivery code     → traveler paid at once
///       (the buyer hands over the code after checking the item; only its hash is stored)
///     Accepted/Delivered (within 7 days): buyer openDispute ─▶ Disputed
///     Disputed:  both sides propose the same split                      → paid out as agreed
///                no agreement within 30 days                            → anyone can settle 50/50
///   Deposits: the buyer locks a refundable deposit (10%) with the payment, and the traveler locks the
///   same amount on accept. Deposits always go back to their owner, except:
///     - deadline passes without delivery → the traveler's deposit goes to the buyer
///     - dispute ends in the 30-day 50/50 → the buyer's deposit goes to the traveler
///   The fee is never taken from deposits.
///   The traveler can attach their shop receipt once (while the deal is running): the photo stays
///   off-chain, the contract stores its hash, the receipt total in euro cents and the time.
///   Once an accepted deal ends (paid, refunded or split), buyer and traveler can each rate the other
///   once: 1–5 stars and a short comment. Only real deals can be rated, so reviews can't be faked.
contract RoamlyEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 500;          // fee can never exceed 5%
    uint16 public constant MAX_DEPOSIT_BPS = 3000;     // deposits can never exceed 30%
    uint64 public constant CONFIRM_WINDOW = 7 days;    // buyer's time to confirm or dispute after delivery
    uint64 public constant DISPUTE_WINDOW = 30 days;   // time to agree on a split before it goes 50/50
    uint256 public constant MAX_COMMENT_BYTES = 280;   // ~140 characters, allowing for Turkish letters
    uint32 public constant MAX_ALLOWANCE_CENTS = 43_000; // Turkey's €430 personal duty-free allowance, per trip
    uint64 public constant DELIVERY_GRACE = 14 days;   // traveler has until the trip date + 14 days to deliver
    uint8 public constant MAX_CAPACITY = 5;
    uint8 public constant ALL_CATEGORIES = 31;         // bits: 0 Electronics, 1 Clothing, 2 Cosmetics, 3 General, 4 Alcohol
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_NOTES_BYTES = 280;
    uint256 public constant MAX_ITEM_BYTES = 120;
    uint256 public constant MAX_LINK_BYTES = 300;

    enum Status { None, Funded, Accepted, Delivered, Disputed, Released, Refunded, Split }

    struct Deal {
        address buyer;
        address traveler;
        uint128 amount;
        uint64 deliverBy;
        uint64 deliveredAt;
        uint64 disputedAt;
        Status status;
        // Dispute offers: amount that goes back to the buyer, stored +1 so 0 means "no offer yet".
        uint128 buyerOffer;
        uint128 travelerOffer;
        bool accepted;       // traveler committed to it — only these deals can be rated
        uint128 buyerDeposit;    // locked with the payment
        uint128 travelerDeposit; // locked on accept (same amount); 0 until then
        bytes32 codeHash;        // keccak256 of the buyer's secret delivery code; 0 = no code
        uint256 tripId;
    }

    struct Trip {
        address traveler;
        uint64 date;         // travel day (unix time)
        uint8 capacity;      // how many items they'll carry
        uint8 categories;    // bitmask, see ALL_CATEGORIES
        uint8 slotsUsed;     // requests holding a slot (everything except refunded ones)
        bool closed;         // no new requests
        uint32 centsUsed;    // euro cents of the allowance those requests use
        string code;         // departure city code, e.g. "PRG"
        string notes;
    }

    struct DealInfo {
        string item;
        string link;
        uint8 category;      // bit index, see ALL_CATEGORIES
        uint32 priceCents;   // item price in euro cents, counted against the allowance
    }

    struct Review {
        uint8 stars;         // 0 = not rated yet, otherwise 1–5
        string comment;
    }

    struct Receipt {
        bytes32 hash;        // keccak256 of the receipt photo; 0 = none attached
        uint32 totalCents;   // receipt total in euro cents, as entered by the traveler
        uint64 attachedAt;
    }

    struct Reputation {
        uint64 count;
        uint64 totalStars;
    }

    IERC20 public immutable token;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    uint16 public immutable depositBps;

    uint256 public dealCount;
    mapping(uint256 => Deal) private _deals;
    mapping(uint256 => Review) private _buyerReviews;    // written by the buyer, about the traveler
    mapping(uint256 => Review) private _travelerReviews; // written by the traveler, about the buyer
    mapping(address => Reputation) public reputation;
    mapping(uint256 => Receipt) public receipts;

    uint256 public tripCount;
    mapping(uint256 => Trip) private _trips;
    mapping(uint256 => DealInfo) private _dealInfo;
    mapping(address => uint256[]) private _tripsOf;
    mapping(address => uint256[]) private _dealsOf;     // deals where the address is buyer or traveler
    mapping(address => string) public names;

    event NameSet(address indexed who, string name);
    event TripListed(uint256 indexed id, address indexed traveler);
    event TripClosed(uint256 indexed id);
    event DealCreated(uint256 indexed id, address indexed buyer, address indexed traveler, uint256 tripId, uint256 amount);
    event DealAccepted(uint256 indexed id);
    event DealDelivered(uint256 indexed id);
    event CodeConfirmed(uint256 indexed id);
    event DealReleased(uint256 indexed id, uint256 toTraveler, uint256 fee);
    event DealRefunded(uint256 indexed id, uint256 toBuyer);
    event DisputeOpened(uint256 indexed id);
    event SplitProposed(uint256 indexed id, address indexed by, uint256 toBuyer);
    event DisputeSettled(uint256 indexed id, uint256 toBuyer, uint256 toTraveler, uint256 fee);
    event ReceiptAttached(uint256 indexed id, bytes32 hash, uint32 totalCents);
    event Rated(uint256 indexed id, address indexed from, address indexed to, uint8 stars, string comment);

    error InvalidParams();
    error NotBuyer();
    error NotTraveler();
    error NotParty();
    error WrongStatus(Status current);
    error TooEarly();
    error TooLate();
    error AlreadyRated();
    error WrongCode();
    error AlreadyAttached();
    error TripNotOpen();
    error TripFull();
    error OverAllowance();
    error CategoryNotCarried();

    constructor(IERC20 token_, address feeRecipient_, uint16 feeBps_, uint16 depositBps_) {
        if (address(token_) == address(0) || feeRecipient_ == address(0) || feeBps_ > MAX_FEE_BPS || depositBps_ > MAX_DEPOSIT_BPS) revert InvalidParams();
        token = token_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        depositBps = depositBps_;
    }

    // ---------- Profiles and trips ----------

    /// @notice Set the name shown for your wallet (empty clears it).
    function setName(string calldata name) external {
        if (bytes(name).length > MAX_NAME_BYTES) revert InvalidParams();
        names[msg.sender] = name;
        emit NameSet(msg.sender, name);
    }

    /// @param date travel day as unix time; today is allowed (up to a day in the past, for time zones)
    function listTrip(string calldata code, uint64 date, uint8 capacity, uint8 categories, string calldata notes) external returns (uint256 id) {
        if (bytes(code).length != 3 || capacity == 0 || capacity > MAX_CAPACITY || categories == 0 || categories > ALL_CATEGORIES
            || bytes(notes).length > MAX_NOTES_BYTES || uint256(date) + 1 days < block.timestamp) revert InvalidParams();
        id = ++tripCount;
        Trip storage t = _trips[id];
        t.traveler = msg.sender;
        t.date = date;
        t.capacity = capacity;
        t.categories = categories;
        t.code = code;
        t.notes = notes;
        _tripsOf[msg.sender].push(id);
        emit TripListed(id, msg.sender);
    }

    /// @notice Stop taking new requests on a trip. Requests already made carry on.
    function closeTrip(uint256 id) external {
        Trip storage t = _trips[id];
        if (msg.sender != t.traveler) revert NotTraveler();
        t.closed = true;
        emit TripClosed(id);
    }

    // ---------- Buyer ----------

    /// @notice Request an item on a trip: locks `amount` tokens plus the buyer deposit.
    ///         Needs a prior token approve() of amount + depositFor(amount).
    /// @param codeHash keccak256 of a secret delivery code the buyer keeps (0 for none). The code must be
    ///        long and random (the app uses 80 bits): the hash is public, so a short code could be guessed.
    /// @param category bit index of the item's category; the trip must accept it
    /// @param priceCents the item's price in euro cents, counted against the trip's €430 allowance
    function createDeal(uint256 tripId, uint128 amount, bytes32 codeHash, string calldata item, string calldata link, uint8 category, uint32 priceCents)
        external nonReentrant returns (uint256 id)
    {
        Trip storage t = _trips[tripId];
        if (t.traveler == address(0) || t.closed) revert TripNotOpen();
        if (t.traveler == msg.sender || amount == 0 || priceCents == 0 || bytes(item).length == 0
            || bytes(item).length > MAX_ITEM_BYTES || bytes(link).length > MAX_LINK_BYTES) revert InvalidParams();
        if (category > 7 || t.categories & (uint8(1) << category) == 0) revert CategoryNotCarried();
        if (t.slotsUsed >= t.capacity) revert TripFull();
        if (uint256(t.centsUsed) + priceCents > MAX_ALLOWANCE_CENTS) revert OverAllowance();
        uint64 deliverBy = t.date + DELIVERY_GRACE;
        if (deliverBy <= block.timestamp) revert TooLate();
        t.slotsUsed += 1;
        t.centsUsed += priceCents;

        id = ++dealCount;
        Deal storage d = _deals[id];
        d.buyer = msg.sender;
        d.traveler = t.traveler;
        d.amount = amount;
        d.deliverBy = deliverBy;
        d.status = Status.Funded;
        d.buyerDeposit = uint128(depositFor(amount));
        d.codeHash = codeHash;
        d.tripId = tripId;
        _dealInfo[id] = DealInfo(item, link, category, priceCents);
        _dealsOf[msg.sender].push(id);
        _dealsOf[t.traveler].push(id);
        token.safeTransferFrom(msg.sender, address(this), uint256(amount) + d.buyerDeposit);
        emit DealCreated(id, msg.sender, t.traveler, tripId, amount);
    }

    /// @notice Withdraw a request the traveler hasn't accepted yet.
    function cancel(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer) revert NotBuyer();
        _requireStatus(d, Status.Funded);
        _refund(id, d);
    }

    /// @notice Buyer received the item: pay the traveler.
    function confirmDelivery(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer) revert NotBuyer();
        if (d.status != Status.Accepted && d.status != Status.Delivered) revert WrongStatus(d.status);
        _release(id, d);
    }

    /// @notice Freeze the funds. Only the buyer can dispute; the traveler is protected by the
    ///         7-day auto-release instead. After delivery, disputes close with that window.
    function openDispute(uint256 id) external {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer) revert NotBuyer();
        if (d.status == Status.Delivered) {
            if (block.timestamp >= d.deliveredAt + CONFIRM_WINDOW) revert TooLate();
        } else if (d.status != Status.Accepted) {
            revert WrongStatus(d.status);
        }
        d.status = Status.Disputed;
        d.disputedAt = uint64(block.timestamp);
        emit DisputeOpened(id);
    }

    // ---------- Traveler ----------

    /// @notice Commit to carrying the item. Locks the traveler deposit (same as the buyer's),
    ///         so needs a prior token approve() of that amount.
    function accept(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        _requireStatus(d, Status.Funded);
        if (block.timestamp > d.deliverBy) revert TooLate();
        d.status = Status.Accepted;
        d.accepted = true;
        d.travelerDeposit = d.buyerDeposit;
        if (d.travelerDeposit > 0) token.safeTransferFrom(msg.sender, address(this), d.travelerDeposit);
        emit DealAccepted(id);
    }

    function decline(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        _requireStatus(d, Status.Funded);
        _refund(id, d);
    }

    /// @notice The buyer handed over their delivery code: that's their confirmation, so pay out now.
    function confirmWithCode(uint256 id, string calldata code) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        if (d.status != Status.Accepted && d.status != Status.Delivered) revert WrongStatus(d.status);
        if (d.codeHash == bytes32(0) || keccak256(bytes(code)) != d.codeHash) revert WrongCode();
        emit CodeConfirmed(id);
        _release(id, d);
    }

    /// @notice Delivery without the code (e.g. the buyer wasn't there): starts the buyer's
    ///         7-day window to confirm or dispute.
    function markDelivered(uint256 id) external {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        _requireStatus(d, Status.Accepted);
        d.status = Status.Delivered;
        d.deliveredAt = uint64(block.timestamp);
        emit DealDelivered(id);
    }

    /// @notice Record the shop receipt: its photo's hash and total. Once per deal, so it can't be swapped later.
    function attachReceipt(uint256 id, bytes32 hash, uint32 totalCents) external {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        if (d.status != Status.Accepted && d.status != Status.Delivered && d.status != Status.Disputed) revert WrongStatus(d.status);
        if (hash == bytes32(0) || totalCents == 0) revert InvalidParams();
        Receipt storage r = receipts[id];
        if (r.hash != bytes32(0)) revert AlreadyAttached();
        r.hash = hash;
        r.totalCents = totalCents;
        r.attachedAt = uint64(block.timestamp);
        emit ReceiptAttached(id, hash, totalCents);
    }

    // ---------- Timeouts (anyone can trigger; funds only go where the rules say) ----------

    /// @notice Pay the traveler once the buyer stayed silent for 7 days after delivery.
    function claimPayment(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        _requireStatus(d, Status.Delivered);
        if (block.timestamp < d.deliveredAt + CONFIRM_WINDOW) revert TooEarly();
        _release(id, d);
    }

    /// @notice Refund the buyer when the deadline passed without the item being marked delivered.
    ///         If the traveler had accepted, their deposit goes to the buyer too.
    function claimRefund(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (d.status != Status.Funded && d.status != Status.Accepted) revert WrongStatus(d.status);
        if (block.timestamp <= d.deliverBy) revert TooEarly();
        _refund(id, d);
    }

    // ---------- Disputes ----------

    /// @notice Offer to settle by sending `toBuyer` back and the rest to the traveler.
    ///         When both sides have offered the same split, it's paid out immediately.
    function proposeSplit(uint256 id, uint128 toBuyer) external nonReentrant {
        Deal storage d = _deals[id];
        _requireStatus(d, Status.Disputed);
        if (toBuyer > d.amount) revert InvalidParams();
        if (msg.sender == d.buyer) d.buyerOffer = toBuyer + 1;
        else if (msg.sender == d.traveler) d.travelerOffer = toBuyer + 1;
        else revert NotParty();
        emit SplitProposed(id, msg.sender, toBuyer);
        if (d.buyerOffer == d.travelerOffer) _settle(id, d, toBuyer, false);
    }

    /// @notice No agreement after 30 days: split evenly so funds are never stuck.
    ///         The buyer who opened the dispute loses their deposit to the traveler.
    function settleStalemate(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        _requireStatus(d, Status.Disputed);
        if (block.timestamp < d.disputedAt + DISPUTE_WINDOW) revert TooEarly();
        _settle(id, d, d.amount / 2, true);
    }

    // ---------- Ratings ----------

    /// @notice Rate the other side of a finished deal, once. 1–5 stars and an optional short comment.
    function rate(uint256 id, uint8 stars, string calldata comment) external {
        Deal storage d = _deals[id];
        if (stars < 1 || stars > 5 || bytes(comment).length > MAX_COMMENT_BYTES) revert InvalidParams();
        if (!d.accepted || (d.status != Status.Released && d.status != Status.Refunded && d.status != Status.Split)) revert WrongStatus(d.status);
        Review storage r;
        address subject;
        if (msg.sender == d.buyer) { r = _buyerReviews[id]; subject = d.traveler; }
        else if (msg.sender == d.traveler) { r = _travelerReviews[id]; subject = d.buyer; }
        else revert NotParty();
        if (r.stars != 0) revert AlreadyRated();
        r.stars = stars;
        r.comment = comment;
        Reputation storage rep = reputation[subject];
        rep.count += 1;
        rep.totalStars += stars;
        emit Rated(id, msg.sender, subject, stars, comment);
    }

    /// @return byBuyer the buyer's review of the traveler; byTraveler the traveler's review of the buyer
    function getReviews(uint256 id) external view returns (Review memory byBuyer, Review memory byTraveler) {
        return (_buyerReviews[id], _travelerReviews[id]);
    }

    // ---------- Views ----------

    function getDeal(uint256 id) external view returns (Deal memory) {
        return _deals[id];
    }

    function getDealInfo(uint256 id) external view returns (DealInfo memory) {
        return _dealInfo[id];
    }

    function getTrip(uint256 id) external view returns (Trip memory) {
        return _trips[id];
    }

    /// @notice Trips `from` .. `from + count - 1` (ids start at 1), cut off at the last trip.
    function getTrips(uint256 from, uint256 count) external view returns (Trip[] memory list) {
        if (from == 0 || from > tripCount) return new Trip[](0);
        uint256 end = from + count - 1;
        if (end > tripCount) end = tripCount;
        list = new Trip[](end - from + 1);
        for (uint256 i = from; i <= end; i++) list[i - from] = _trips[i];
    }

    function tripsOf(address who) external view returns (uint256[] memory) {
        return _tripsOf[who];
    }

    function dealsOf(address who) external view returns (uint256[] memory) {
        return _dealsOf[who];
    }

    function feeFor(uint256 amount) public view returns (uint256) {
        return amount * feeBps / 10_000;
    }

    function depositFor(uint256 amount) public view returns (uint256) {
        return amount * depositBps / 10_000;
    }

    // ---------- Internal ----------

    function _requireStatus(Deal storage d, Status s) private view {
        if (d.status != s) revert WrongStatus(d.status);
    }

    /// @dev Refunds only happen before acceptance (no traveler deposit yet) or after a missed
    ///      deadline (traveler deposit forfeited), so the buyer gets everything locked.
    function _refund(uint256 id, Deal storage d) private {
        d.status = Status.Refunded;
        _freeSlot(id, d);
        uint256 toBuyer = uint256(d.amount) + d.buyerDeposit + d.travelerDeposit;
        token.safeTransfer(d.buyer, toBuyer);
        emit DealRefunded(id, toBuyer);
    }

    function _release(uint256 id, Deal storage d) private {
        d.status = Status.Released;
        if (d.buyerDeposit > 0) token.safeTransfer(d.buyer, d.buyerDeposit);
        (uint256 net, uint256 fee) = _payTraveler(d, d.amount, d.travelerDeposit);
        emit DealReleased(id, net, fee);
    }

    /// @param stalemate true when the 30-day window ran out: the buyer's deposit goes to the traveler
    function _settle(uint256 id, Deal storage d, uint256 toBuyer, bool stalemate) private {
        uint256 toTraveler = d.amount - toBuyer;
        d.status = toBuyer == d.amount ? Status.Refunded : toBuyer == 0 ? Status.Released : Status.Split;
        if (d.status == Status.Refunded) _freeSlot(id, d);
        uint256 buyerGets = toBuyer + (stalemate ? 0 : d.buyerDeposit);
        uint256 travelerExtra = d.travelerDeposit + (stalemate ? d.buyerDeposit : 0);
        if (buyerGets > 0) token.safeTransfer(d.buyer, buyerGets);
        (uint256 net, uint256 fee) = _payTraveler(d, toTraveler, travelerExtra);
        emit DisputeSettled(id, buyerGets, net, fee);
    }

    /// @dev A refunded request gives its trip slot and allowance back.
    function _freeSlot(uint256 id, Deal storage d) private {
        Trip storage t = _trips[d.tripId];
        t.slotsUsed -= 1;
        t.centsUsed -= _dealInfo[id].priceCents;
    }

    /// @dev Fee is taken only from the traveler's share of the payment — never from refunds or deposits.
    /// @param deposits deposit money returned to (or won by) the traveler, added fee-free
    function _payTraveler(Deal storage d, uint256 gross, uint256 deposits) private returns (uint256 net, uint256 fee) {
        fee = feeFor(gross);
        net = gross - fee + deposits;
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
        if (net > 0) token.safeTransfer(d.traveler, net);
    }
}
