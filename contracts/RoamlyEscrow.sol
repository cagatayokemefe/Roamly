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
/// Flow:
///   buyer createDeal ─▶ Funded ─ traveler accept ─▶ Accepted ─ traveler markDelivered ─▶ Delivered
///     Funded:    buyer cancel / traveler decline / deadline passes      → buyer refunded
///     Accepted:  buyer confirmDelivery                                  → traveler paid
///                deliverBy passes without delivery                      → buyer can claim refund
///     Delivered: buyer confirmDelivery, or 7 days pass                  → traveler paid
///     Accepted/Delivered (within 7 days): buyer openDispute ─▶ Disputed
///     Disputed:  both sides propose the same split                      → paid out as agreed
///                no agreement within 30 days                            → anyone can settle 50/50
contract RoamlyEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 500;          // fee can never exceed 5%
    uint64 public constant CONFIRM_WINDOW = 7 days;    // buyer's time to confirm or dispute after delivery
    uint64 public constant DISPUTE_WINDOW = 30 days;   // time to agree on a split before it goes 50/50

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
    }

    IERC20 public immutable token;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;

    uint256 public dealCount;
    mapping(uint256 => Deal) private _deals;

    event DealCreated(uint256 indexed id, address indexed buyer, address indexed traveler, uint256 amount, uint64 deliverBy, bytes32 ref);
    event DealAccepted(uint256 indexed id);
    event DealDelivered(uint256 indexed id);
    event DealReleased(uint256 indexed id, uint256 toTraveler, uint256 fee);
    event DealRefunded(uint256 indexed id, uint256 toBuyer);
    event DisputeOpened(uint256 indexed id);
    event SplitProposed(uint256 indexed id, address indexed by, uint256 toBuyer);
    event DisputeSettled(uint256 indexed id, uint256 toBuyer, uint256 toTraveler, uint256 fee);

    error InvalidParams();
    error NotBuyer();
    error NotTraveler();
    error NotParty();
    error WrongStatus(Status current);
    error TooEarly();
    error TooLate();

    constructor(IERC20 token_, address feeRecipient_, uint16 feeBps_) {
        if (address(token_) == address(0) || feeRecipient_ == address(0) || feeBps_ > MAX_FEE_BPS) revert InvalidParams();
        token = token_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    // ---------- Buyer ----------

    /// @notice Lock `amount` tokens for `traveler`. Needs a prior token approve() for this contract.
    /// @param ref Off-chain request id, so the app can link the deal to its listing.
    function createDeal(address traveler, uint128 amount, uint64 deliverBy, bytes32 ref) external nonReentrant returns (uint256 id) {
        if (traveler == address(0) || traveler == msg.sender || amount == 0 || deliverBy <= block.timestamp) revert InvalidParams();
        id = ++dealCount;
        Deal storage d = _deals[id];
        d.buyer = msg.sender;
        d.traveler = traveler;
        d.amount = amount;
        d.deliverBy = deliverBy;
        d.status = Status.Funded;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit DealCreated(id, msg.sender, traveler, amount, deliverBy, ref);
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

    function accept(uint256 id) external {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        _requireStatus(d, Status.Funded);
        if (block.timestamp > d.deliverBy) revert TooLate();
        d.status = Status.Accepted;
        emit DealAccepted(id);
    }

    function decline(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        _requireStatus(d, Status.Funded);
        _refund(id, d);
    }

    /// @notice Starts the buyer's 7-day window to confirm or dispute.
    function markDelivered(uint256 id) external {
        Deal storage d = _deals[id];
        if (msg.sender != d.traveler) revert NotTraveler();
        _requireStatus(d, Status.Accepted);
        d.status = Status.Delivered;
        d.deliveredAt = uint64(block.timestamp);
        emit DealDelivered(id);
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
        if (d.buyerOffer == d.travelerOffer) _settle(id, d, toBuyer);
    }

    /// @notice No agreement after 30 days: split evenly so funds are never stuck.
    function settleStalemate(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        _requireStatus(d, Status.Disputed);
        if (block.timestamp < d.disputedAt + DISPUTE_WINDOW) revert TooEarly();
        _settle(id, d, d.amount / 2);
    }

    // ---------- Views ----------

    function getDeal(uint256 id) external view returns (Deal memory) {
        return _deals[id];
    }

    function feeFor(uint256 amount) public view returns (uint256) {
        return amount * feeBps / 10_000;
    }

    // ---------- Internal ----------

    function _requireStatus(Deal storage d, Status s) private view {
        if (d.status != s) revert WrongStatus(d.status);
    }

    function _refund(uint256 id, Deal storage d) private {
        d.status = Status.Refunded;
        token.safeTransfer(d.buyer, d.amount);
        emit DealRefunded(id, d.amount);
    }

    function _release(uint256 id, Deal storage d) private {
        d.status = Status.Released;
        (uint256 net, uint256 fee) = _payTraveler(d, d.amount);
        emit DealReleased(id, net, fee);
    }

    function _settle(uint256 id, Deal storage d, uint256 toBuyer) private {
        uint256 toTraveler = d.amount - toBuyer;
        d.status = toBuyer == d.amount ? Status.Refunded : toBuyer == 0 ? Status.Released : Status.Split;
        if (toBuyer > 0) token.safeTransfer(d.buyer, toBuyer);
        (uint256 net, uint256 fee) = _payTraveler(d, toTraveler);
        emit DisputeSettled(id, toBuyer, net, fee);
    }

    /// @dev Fee is taken only from the traveler's share; refunds are never charged.
    function _payTraveler(Deal storage d, uint256 gross) private returns (uint256 net, uint256 fee) {
        if (gross == 0) return (0, 0);
        fee = feeFor(gross);
        net = gross - fee;
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
        token.safeTransfer(d.traveler, net);
    }
}
