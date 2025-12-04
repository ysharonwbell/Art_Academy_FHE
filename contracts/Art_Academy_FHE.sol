pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ArtAcademyFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error InvalidState();
    error RateLimited();
    error BatchClosed();
    error BatchFull();
    error InvalidBatch();
    error InvalidRequest();
    error StaleWrite();
    error NotInitialized();

    address public owner;
    bool public paused;
    uint256 public constant MIN_INTERVAL = 5 seconds;
    uint256 public cooldownSeconds = 30;
    uint256 public batchLimit = 10;

    mapping(address => uint256) public lastActionAt;
    mapping(address => bool) public isProvider;
    mapping(uint256 => Artwork) public artworks;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(address => uint256) public providerCooldowns;

    uint256 public nextArtworkId = 1;
    uint256 public nextBatchId = 1;
    uint256 public currentBatchId = 0;
    uint256 public modelVersion = 1;

    struct Artwork {
        address artist;
        euint32 encryptedScore;
        uint256 version;
    }

    struct Batch {
        uint256 id;
        uint256 openedAt;
        uint256 closedAt;
        uint256 artworkCount;
        euint32 encryptedTotalScore;
        bool isFinalized;
    }

    struct DecryptionContext {
        uint256 modelVersion;
        bytes32 stateHash;
        bool processed;
        address requester;
        uint256 batchId;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event ArtworkSubmitted(uint256 indexed artworkId, address indexed artist);
    event BatchOpened(uint256 indexed batchId, uint256 openedAt);
    event BatchClosed(uint256 indexed batchId, uint256 closedAt);
    event BatchFinalized(uint256 indexed batchId, uint256 artworkCount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, address indexed requester);
    event DecryptionComplete(uint256 indexed requestId, uint256 indexed batchId, uint256 totalScore);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier rateLimited() {
        if (block.timestamp < lastActionAt[msg.sender] + cooldownSeconds) {
            revert RateLimited();
        }
        lastActionAt[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        _openNewBatch();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        require(newCooldown >= MIN_INTERVAL, "Cooldown too short");
        emit CooldownUpdated(cooldownSeconds, newCooldown);
        cooldownSeconds = newCooldown;
    }

    function setBatchLimit(uint256 newLimit) external onlyOwner {
        require(newLimit > 0, "Invalid batch limit");
        emit BatchLimitUpdated(batchLimit, newLimit);
        batchLimit = newLimit;
    }

    function submitArtwork(euint32 encryptedScore) external whenNotPaused rateLimited {
        if (currentBatchId == 0 || batches[currentBatchId].isFinalized) {
            revert BatchClosed();
        }
        if (batches[currentBatchId].artworkCount >= batchLimit) {
            revert BatchFull();
        }

        uint256 artworkId = nextArtworkId++;
        _requireInitialized(encryptedScore, "Artwork score not initialized");

        artworks[artworkId] = Artwork({
            artist: msg.sender,
            encryptedScore: encryptedScore,
            version: modelVersion
        });

        batches[currentBatchId].encryptedTotalScore = FHE.add(
            batches[currentBatchId].encryptedTotalScore,
            encryptedScore
        );
        batches[currentBatchId].artworkCount++;

        emit ArtworkSubmitted(artworkId, msg.sender);
    }

    function openNewBatch() external onlyOwner {
        if (currentBatchId != 0 && !batches[currentBatchId].isFinalized) {
            revert BatchOpenError();
        }
        _openNewBatch();
    }

    function _openNewBatch() internal {
        uint256 batchId = nextBatchId++;
        currentBatchId = batchId;
        batches[batchId] = Batch({
            id: batchId,
            openedAt: block.timestamp,
            closedAt: 0,
            artworkCount: 0,
            encryptedTotalScore: FHE.asEuint32(0),
            isFinalized: false
        });
        emit BatchOpened(batchId, block.timestamp);
    }

    function closeCurrentBatch() external onlyOwner {
        if (currentBatchId == 0) revert InvalidBatch();
        Batch storage batch = batches[currentBatchId];
        if (batch.isFinalized) revert BatchClosed();

        batch.closedAt = block.timestamp;
        batch.isFinalized = true;
        emit BatchClosed(batch.id, batch.closedAt);
        emit BatchFinalized(batch.id, batch.artworkCount);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused rateLimited {
        if (batchId == 0 || batchId >= nextBatchId || !batches[batchId].isFinalized) {
            revert InvalidBatch();
        }

        euint32 memory totalScore = batches[batchId].encryptedTotalScore;
        _requireInitialized(totalScore, "Batch score not initialized");

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(totalScore);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.handleBatchDecryption.selector);

        decryptionContexts[requestId] = DecryptionContext({
            modelVersion: modelVersion,
            stateHash: stateHash,
            processed: false,
            requester: msg.sender,
            batchId: batchId
        });

        emit DecryptionRequested(requestId, batchId, msg.sender);
    }

    function handleBatchDecryption(uint256 requestId, bytes memory cleartexts, bytes memory proof) external {
        if (decryptionContexts[requestId].processed) revert InvalidRequest();

        DecryptionContext storage context = decryptionContexts[requestId];
        require(context.requester != address(0), "Invalid context");

        euint32 memory currentScore = batches[context.batchId].encryptedTotalScore;
        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = FHE.toBytes32(currentScore);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != context.stateHash) revert InvalidState();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32 totalScore;
        assembly {
            totalScore := mload(add(cleartexts, 0x20))
        }

        context.processed = true;
        emit DecryptionComplete(requestId, context.batchId, totalScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal view returns (euint32) {
        if (!FHE.isInitialized(x)) {
            return FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) internal view {
        if (!FHE.isInitialized(x)) {
            revert NotInitialized();
        }
    }
}