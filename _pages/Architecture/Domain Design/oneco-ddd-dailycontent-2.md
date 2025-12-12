---
title: "[ONECO DDD 도메인 설계 시리즈 Part 2] DailyContent 애그리거트 뜯어보기"
date: 2025-12-12 17:30:00 +0900
tags:
- DDD
- domain-driven design
- domain design
- architecture
- aggregate
- domain model
- entity
thumbnail: "/assets/img/thumbnail/oneco-ddd-dailycontent.png"
---


# [ONECO DDD 도메인 설계 시리즈 Part 2] DailyContent 애그리거트 뜯어보기

> Part 1에서는 “왜 DailyContent를 애그리거트 루트로 두었는가”를 개념적으로 정리했다면,
이번 Part 2는 **실제 코드 한 파일(DailyContent.java)(애그리거트)을 기준으로 설계 의도와 동작 방식을 해부**하는 글이다.
>

---

## 0. 도메인 구조 & 전체 코드 원문

<img width="1647" height="612" alt="image" src="https://github.com/user-attachments/assets/a6559a60-a1a9-404a-b516-ffd72a7451cd" />

먼저 기준이 되는 `DailyContent` 애그리거트 전체 코드이다.

(프로젝트를 진행하며 수정되거나 추가될 수도 있다. 수정된 코드는 깃허브에서 확인할 수 있다.)

```java
@Entity
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@Table(name = "daily_contents",
    uniqueConstraints = {
        @UniqueConstraint(
            name= "uk_category_day_sequence",
            columnNames = {"category_id", "day_sequence"}
        )
    })
public class DailyContent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Embedded
    private CategoryId categoryId;

    @Convert(converter = DaySequenceConverter.class)
    private DaySequence daySequence;

    @Embedded
    private ContentDescription description;

    @Embedded
    private Keyword keyword;

    @Embedded
    @AttributeOverride(name = "url", column = @Column(name = "image_url", nullable = false))
    private ImageFile imageFile;

    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
    @JoinColumn(name = "daily_content_id", nullable = false)
    private List<NewsItem> newsItems = new ArrayList<>();

    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
    @JoinColumn(name = "daily_content_id", nullable = false)
    private List<Quiz> quizzes = new ArrayList<>();

    private DailyContent(
        CategoryId categoryId,
        DaySequence daySequence,
        Keyword keyword,
        ContentDescription description,
        ImageFile imageFile
    ) {
        if(categoryId == null) {
            throw new IllegalArgumentException("categoryId는 null일 수 없습니다.");
        }
        if(daySequence == null) {
            throw new IllegalArgumentException("daySequence는 null일 수 없습니다.");
        }
        if(keyword == null) {
            throw new IllegalArgumentException("keyword는 null일 수 없습니다.");
        }
        if(description == null) {
            throw new IllegalArgumentException("description는 null일 수 없습니다.");
        }
        if(imageFile == null) {
            throw new IllegalArgumentException("imageFile는 null일 수 없습니다.");
        }
        this.categoryId = categoryId;
        this.daySequence = daySequence;
        this.keyword = keyword;
        this.description = description;
        this.imageFile = imageFile;
    }

    public static DailyContent create(
        CategoryId categoryId,
        DaySequence daySequence,
        Keyword keyword,
        ContentDescription description,
        ImageFile imageFile
    ) {
        return new DailyContent(categoryId, daySequence, keyword, description, imageFile);
    }

    public void updateDescription(ContentDescription newDescription) {
        Objects.requireNonNull(newDescription, "newDescription은 null일 수 없습니다.");
        this.description = newDescription;
    }

    public void changeSummary(String newSummary) {
        this.description = this.description.withSummary(newSummary);
    }

    public void changeTitle(String newTitle){
        this.description = this.description.withTitle(newTitle);
    }

    public void changeBodyText(String newBodyText) {
        this.description = this.description.withBodyText(newBodyText);
    }

    public List<NewsItem> getNewsItems(){
        return List.copyOf(newsItems);
    }

    public void updateNewsTitle(NewsItemOrder order, String newTitle) {
        NewsItem target = this.newsItems.stream()
            .filter(item -> item.getNewsItemOrder().equals(order))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("해당 순번의 뉴스가 존재하지 않습니다."));

        target.changeTitle(newTitle);
    }

    public void updateQuizQuestion(QuestionOrder order, String newQuestion) {
        Quiz target = this.quizzes.stream()
            .filter(q -> q.getQuestionOrder().equals(order))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("해당 순번의 퀴즈가 존재하지 않습니다."));

        target.changeQuestion(newQuestion);
    }

    public NewsItem addNewsItem(
        String title,
        NewsItemOrder order,
        WebLink link,
        ImageFile imageFile
    ) {
        Objects.requireNonNull(title, "title은 null일 수 없다.");
        Objects.requireNonNull(order, "order는 null일 수 없다.");
        Objects.requireNonNull(imageFile, "imageFile은 null일 수 없다.");
        Objects.requireNonNull(link, "link는 null일 수 없다.");

        validateNewsOrderDuplicate(order);

        NewsItem item = NewsItem.create(title, link, order, imageFile);
        newsItems.add(item);
        return item;
    }

    public void removeNewsItem( NewsItem item) {
        if (item ==null) {
            throw new IllegalArgumentException("뉴스 아이템은 null일 수 없습니다.");
        }
        newsItems.remove(item);
    }

    public void removeNewsItemByOrder(NewsItemOrder order) {
        boolean removed = this.newsItems.removeIf(item -> item.getNewsItemOrder().equals(order));
        if (!removed) {
            throw new IllegalArgumentException("삭제할 뉴스가 존재하지 않습니다.");
        }
    }

    public void changeKeyword(Keyword newKeyword) {
        Objects.requireNonNull(newKeyword, "newKeyword는 null일 수 없다.");
        this.keyword = newKeyword;
    }

    public void changeImage(ImageFile newImageFile) {
        Objects.requireNonNull(newImageFile, "newImageFile는 null일 수 없다.");
        this.imageFile = newImageFile;
    }

    public boolean isSameCategory(CategoryId other) {
        return this.categoryId.equals(other);
    }

    public List<Quiz> getQuizzes(){
        return List.copyOf(quizzes);
    }

    public Quiz addQuiz(
        String question,
        QuestionOrder order,
        QuizOptions options,
        AnswerIndex answerIndex
    ) {
        Objects.requireNonNull(question, "question은 null일 수 없다.");
        Objects.requireNonNull(order, "order는 null일 수 없다.");
        Objects.requireNonNull(options, "options는 null일 수 없다.");
        Objects.requireNonNull(answerIndex, "answerIndex는 null일 수 없다.");

        validateQuizOrderDuplicate(order);

        Quiz quiz = Quiz.create(question, order, options, answerIndex);
        quizzes.add(quiz);
        return quiz;
    }

    public void removeQuiz( Quiz quiz) {
        if (quiz ==null) {
            throw new IllegalArgumentException("퀴즈는 null일 수 없습니다.");
        }
        quizzes.remove(quiz);
    }

    public void removeQuizByOrder(QuestionOrder order) {
        boolean removed = this.quizzes.removeIf(q -> q.getQuestionOrder().equals(order));
        if (!removed) {
            throw new IllegalArgumentException("삭제할 퀴즈가 존재하지 않습니다: " + order.value());
        }
    }

    private void validateNewsOrderDuplicate(NewsItemOrder order) {
        if (newsItems.stream().anyMatch(n -> n.getNewsItemOrder().equals(order))) {
            throw new IllegalArgumentException("동일한 뉴스 순번이 이미 존재합니다: " + order.value());
        }
    }

    private void validateQuizOrderDuplicate(QuestionOrder order) {
        if (quizzes.stream().anyMatch(q -> q.getQuestionOrder().equals(order))) {
            throw new IllegalArgumentException("동일한 퀴즈 순번이 이미 존재합니다: " + order.value());
        }
    }
}

```

이제 이 코드를 “애그리거트 루트로서 어떤 책임을 갖고 있는지” 관점에서 단계적으로 살펴본다.

---

## 1. 애그리거트 @Entity, @Table, 유니크 제약

```java
@Entity
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@Table(name = "daily_contents",
uniqueConstraints = {
@UniqueConstraint(
name= "uk_category_day_sequence",
columnNames = {"category_id", "day_sequence"}
)
})
public class DailyContent { ... }
```

여기에는 세 가지 의도가 들어 있다.

1. `@Entity` + `@Table(name = "daily_contents")`

   도메인 이름은 `DailyContent`지만, 테이블은 `daily_contents` 로 복수형 snake_case를 사용했다.

   스키마만 열어봐도 “여러 개의 DailyContent가 모여 있는 테이블”이라는 사실을 직관적으로 알 수 있게 하기 위한 선택이다.

2. `@NoArgsConstructor(access = PROTECTED)`

   JPA가 리플렉션으로 인스턴스를 만들 수 있도록 기본 생성자는 열어두되,

   애플리케이션 코드에서 무분별하게 `new DailyContent()` 하지 못하도록 보호한다.

   실제 생성 경로는 아래에서 볼 `create(...)` 팩토리로만 강제된다.

3. `@UniqueConstraint(category_id, day_sequence)`

   `(카테고리, 일차)` 조합이 유일해야 한다는 비즈니스 규칙을 DB까지 내리는 선택이다.

    - 도메인 규칙: “카테고리 A의 3일차 DailyContent는 단 하나만 존재한다.”
    - 이 규칙을 RDB의 유니크 키로 함께 보강함으로써, 애플리케이션 버그나 동시성 이슈로 인한 중복 생성도 차단한다.

DDD 관점에서 보면, **애그리거트 루트의 핵심 불변식 하나를 데이터베이스에 위임**한 형태이다.

---

## 2. 하루치 학습 경험을 표현하는 값 객체들

DailyContent는 원시 타입을 거의 사용하지 않고 대부분을 VO로 감싼다.

```java
@Embedded
private CategoryId categoryId;

@Convert(converter = DaySequenceConverter.class)
private DaySequence daySequence;

@Embedded
private ContentDescription description;

@Embedded
private Keyword keyword;

@Embedded
@AttributeOverride(name = "url", column = @Column(name = "image_url", nullable = false))
private ImageFile imageFile;

```

각 VO의 역할은 다음과 같다.

### 2.1 CategoryId

- 단순 `Long categoryId` 대신 `CategoryId` VO 사용.
- 값 생성 시 “양수인지, null 아닌지”를 VO 내부에서 보장한다.
- 다른 애그리거트(카테고리)와 연결되는 키이기도 하기 때문에, 의미 있는 타입으로 감싸 검증 포인트를 한 곳에 모았다.

### 2.2 DaySequence

- “이 카테고리에서 몇 번째 날인지(1일차, 2일차…)” 를 표현하는 타입.
- `AbstractSequence`를 상속하여 “1 이상”이라는 공통 규칙을 재사용한다.
- JPA 매핑은 `@Convert(converter = DaySequenceConverter.class)` 를 통해 INT 한 컬럼으로 저장한다.
- 도메인 코드에서는 항상 `DaySequence` 타입으로 다룸으로써, 날짜/일차 개념이 섞이지 않도록 한다.

### 2.3 ContentDescription

- `title`, `summary`, `bodyText` 를 하나의 VO로 묶었다.
- 길이 제한, 공백 허용 여부, null 불가 등의 검증은 모두 VO 생성 시점에 수행된다.
- DailyContent는 “설명 자체가 null인지” 정도만 체크하고, 문자열 유효성은 VO에 위임한다.

### 2.4 Keyword

- 오늘의 핵심 키워드(예: “기준금리”, “양적완화”)를 표현한다.
- 최대 길이, 공백 제거(trim), 빈 문자열 방지 등의 검증을 VO 내부에서 수행한다.

### 2.5 ImageFile

- 대표 이미지에 대한 url을 표현하는 VO.
- 지금은 url 한 개만 갖지만, 나중에 “허용 도메인, 허용 확장자, 규격” 같은 정책을 추가할 때도 이 타입 안에서 일관되게 처리할 수 있다.

**요약**

DailyContent는 “하루치 학습 경험”을 구성하는 요소들을 전부 **의미 있는 타입**(VO)으로 받고,

각 VO는 “자기 값은 자기 책임으로 검증하는” 구조를 가진다.

애그리거트 루트는 값의 조합과 일관성에 집중하고, 값 자체의 정합성은 VO 레벨에서 담당한다.

---

## 3. NewsItem / Quiz 컬렉션: 애그리거트 내부 엔티티 관리

```java
@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
private List<NewsItem> newsItems = new ArrayList<>();

@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
private List<Quiz> quizzes = new ArrayList<>();

```

여기에는 애그리거트 생명주기와 관련된 설계 의도가 들어 있다.

부모 자체를 삭제하면 cascade, 컬렉션에서 자식만 빼면 orphanRemoval이 동작한다.

### 3.1 cascade = CascadeType.ALL

- DailyContent를 저장/삭제할 때, 관련된 NewsItem/Quiz도 함께 저장/삭제된다.
- 즉, “하루치 콘텐츠”의 생명주기에 뉴스·퀴즈를 묶는다.
- DDD 용어로, NewsItem과 Quiz는 **같은 애그리거트에 속한 엔티티**이며, 루트인 DailyContent가 이들의 생명주기를 관리한다.

### 3.2 orphanRemoval = true

- DailyContent에서 제거된 NewsItem/Quiz는 DB에서도 자동 삭제된다.
- 즉, “부모(DailyContent)와의 연결이 끊긴 자식(NewsItem/Quiz)은 자동으로 DB에서 DELETE 하겠다” 라는 옵션이다.
    - 컬렉션에서 분리된 자식 엔티티를 그냥 메모리에서만 떼어내는 게 아니라, DB에서도 같이 지워주는 옵션
- 관리 UI에서 DailyContent의 뉴스 한 개를 제거하면, JPA가 해당 NewsItem을 고아 객체로 판단하여 DB에서 DELETE까지 자동으로 해준다.

### 3.3 단방향 OneToMany + FK

- `@JoinColumn(name = "daily_content_id")` 를 통해 자식 테이블에 FK를 두되,
- 자식 엔티티(NewsItem, Quiz) 쪽에는 `@ManyToOne` 필드가 없다.
- 즉, 도메인 모델 상으로는 “DailyContent → 자식들” 단방향만 존재한다.

이는 “부모(하루치 경험)를 중심으로만 모델을 다루겠다”는 의도에 가깝다.

조회 최적화가 필요해지면, 별도의 조회용 쿼리/리포지토리를 두는 방식으로 보완할 수 있다.

---

## 4. 생성과 팩토리: 생성 시점에 불변식 잠그기

```java
private DailyContent(
    CategoryId categoryId,
    DaySequence daySequence,
    Keyword keyword,
    ContentDescription description,
    ImageFile imageFile
) {
		this.categoryId = Objects.requireNonNull(categoryId, "categoryId는 null일 수 없습니다.");
    this.daySequence = Objects.requireNonNull(daySequence, "daySequence는 null일 수 없습니다.");
    this.keyword = Objects.requireNonNull(keyword, "keyword는 null일 수 없습니다.");
    this.description = Objects.requireNonNull(description, "description은 null일 수 없습니다.");
    this.imageFile = Objects.requireNonNull(imageFile, "imageFile는 null일 수 없습니다.");
}

public static DailyContent create(
    CategoryId categoryId,
    DaySequence daySequence,
    Keyword keyword,
    ContentDescription description,
    ImageFile imageFile
) {
    return new DailyContent(categoryId, daySequence, keyword, description, imageFile);
}

```

### 설계 포인트

1. 생성자는 `private`, 생성 경로는 `create(...)` 로만
- JPA용 기본 생성자 외에,

  애플리케이션 코드에서 사용할 생성 경로를 정적 팩토리 하나로 통일했다.

- 생성 시 검증 로직이 늘어나도 팩토리 내부만 수정하면 되고, 호출부는 그대로 유지된다.
1. 루트에서 하는 검증 vs VO에서 하는 검증
- 루트는 “필수 구성요소가 null이 아닌가?”를 체크한다.
- VO는 “값 자체가 유효한가?(양수인지, 길이 제한 안쪽인지 등)”를 체크한다.
- 이 레이어 분리를 통해, 생성 시점의 책임을 명확하게 나눌 수 있다.

### 서비스 계층에서의 사용 예

```java
@Service
@RequiredArgsConstructor
public class DailyContentService {

    private final DailyContentRepository dailyContentRepository;

    @Transactional
    public DailyContent createDailyContent(CreateDailyContentCommand cmd) {
        DailyContent dailyContent = DailyContent.create(
            CategoryId.of(cmd.categoryId()),
            new DaySequence(cmd.daySequence()),
            Keyword.of(cmd.keyword()),
            ContentDescription.of(cmd.title(), cmd.summary(), cmd.body()),
            ImageFile.of(cmd.imageUrl())
        );

        return dailyContentRepository.save(dailyContent);
    }
}

```

서비스는 다음 역할만 가진다.

- 원시 입력값 → VO 변환
- 애그리거트 생성/저장 오케스트레이션

**도메인 규칙(필수 값, 조합의 의미, VO 유효성)은 모두 루트와 VO 내부에 몰아둔 구조**다.

---

## 5. 설명/키워드/이미지 변경: VO 교체 기반의 변경

```java
public void updateDescription(ContentDescription newDescription) {
    Objects.requireNonNull(newDescription, "newDescription은 null일 수 없습니다.");
    this.description = newDescription;
}

public void changeSummary(String newSummary) {
    this.description = this.description.withSummary(newSummary);
}

public void changeTitle(String newTitle){
    this.description = this.description.withTitle(newTitle);
}

public void changeBodyText(String newBodyText) {
    this.description = this.description.withBodyText(newBodyText);
}

public void changeKeyword(Keyword newKeyword) {
    Objects.requireNonNull(newKeyword, "newKeyword는 null일 수 없다.");
    this.keyword = newKeyword;
}

public void changeImage(ImageFile newImageFile) {
    Objects.requireNonNull(newImageFile, "newImageFile는 null일 수 없다.");
    this.imageFile = newImageFile;
}

```

### 핵심 아이디어

1. VO를 직접 수정하지 않고 **새 VO로 교체**한다.
- `withSummary`, `withTitle` 등은 새로운 `ContentDescription` 인스턴스를 만들어 반환한다.
- 기존 VO는 불변 객체로 취급되며, 변경은 항상 “새 객체로 교체” 형태로 일어난다.
1. 루트는 “null 방지”까지만 책임
- null 방지는 DailyContent가,
- 문자열 길이/형식 검증 등은 VO가 맡는다.
- 단, String의 null/공백/길이 규칙은 `ContentDescription` 안에서만 관리한다.

서비스 계층에서의 사용 예는 다음과 같이 단순하다.

```java
@Transactional
public void updateDailyContentSummary(Long dailyContentId, String newSummary) {
    DailyContent dc = dailyContentRepository.findById(dailyContentId)
        .orElseThrow(() -> new NotFoundException("DailyContent not found"));

    dc.changeSummary(newSummary);
}

```

---

## 6. 컬렉션 보호와 도메인 메서드 기반 조작

### 6.1. 읽기 전용 뷰 제공

```java
public List<NewsItem> getNewsItems(){
    return List.copyOf(newsItems);
}

public List<Quiz> getQuizzes(){
    return List.copyOf(quizzes);
}

```

- `List.copyOf(...)` 를 사용해 방어적 복사 + 불변 리스트를 반환한다.
- 외부 코드에서 `getNewsItems().add(...)` 같은 조작을 시도하면 `UnsupportedOperationException` 이 발생한다.
- 즉, **구조 변경은 반드시 애그리거트 루트의 메서드를 거치도록 강제**한 것이다.

### 6.2. 추가/삭제는 루트 메서드를 통해서만

뉴스 추가:

```java
public NewsItem addNewsItem(
    String title,
    NewsItemOrder order,
    WebLink link,
    ImageFile imageFile
) {
    Objects.requireNonNull(title, "title은 null일 수 없다.");
    Objects.requireNonNull(order, "order는 null일 수 없다.");
    Objects.requireNonNull(imageFile, "imageFile은 null일 수 없다.");
    Objects.requireNonNull(link, "link는 null일 수 없다.");

    validateNewsOrderDuplicate(order);

    NewsItem item = NewsItem.create(title, link, order, imageFile);
    newsItems.add(item);
    return item;
}

```

퀴즈 추가:

```java
public Quiz addQuiz(
    String question,
    QuestionOrder order,
    QuizOptions options,
    AnswerIndex answerIndex
) {
    Objects.requireNonNull(question, "question은 null일 수 없다.");
    Objects.requireNonNull(order, "order는 null일 수 없다.");
    Objects.requireNonNull(options, "options는 null일 수 없다.");
    Objects.requireNonNull(answerIndex, "answerIndex는 null일 수 없다.");

    validateQuizOrderDuplicate(order);

    Quiz quiz = Quiz.create(question, order, options, answerIndex);
    quizzes.add(quiz);
    return quiz;
}

```

중복 순번 검증:

```java
private void validateNewsOrderDuplicate(NewsItemOrder order) {
    if (newsItems.stream().anyMatch(n -> n.getNewsItemOrder().equals(order))) {
        throw new IllegalArgumentException("동일한 뉴스 순번이 이미 존재합니다: " + order.value());
    }
}

private void validateQuizOrderDuplicate(QuestionOrder order) {
    if (quizzes.stream().anyMatch(q -> q.getQuestionOrder().equals(order))) {
        throw new IllegalArgumentException("동일한 퀴즈 순번이 이미 존재합니다: " + order.value());
    }
}

```

설계 의도는 명확하다.

- “뉴스/퀴즈 추가”는 반드시 루트의 도메인 메서드를 통과해야 한다.
- 그 안에서
    - 필수 값 null 방지
    - 순번(order) 중복 방지
    - 내부 엔티티 생성 규칙

      를 모두 처리한다.


서비스에서는 다음과 같이 사용하게 된다.

```java
@Transactional
public void addNewsToDailyContent(Long dailyContentId, AddNewsCommand cmd) {
    DailyContent dc = dailyContentRepository.findById(dailyContentId)
        .orElseThrow(() -> new NotFoundException("DailyContent not found"));

    dc.addNewsItem(
        cmd.title(),
        new NewsItemOrder(cmd.order()),
        WebLink.of(cmd.url()),
        ImageFile.of(cmd.imageUrl())
    );
}

```

외부에서 `newsItems.add(...)` 를 직접 호출할 수 없기 때문에,

애그리거트 불변식을 우회해서 깨뜨리기 어렵다.

---

## 7. 서비스 계층에서 본 “하루치 경험” 생성 흐름

DailyContent를 기준으로 “하루치 학습 경험 + 뉴스 + 퀴즈” 를 한 번에 생성하는 흐름을 예로 들면 다음과 같다.

```java
@Transactional
public Long createWithNewsAndQuiz(CreateDailyContentAllInOneCommand cmd) {

    DailyContent dc = DailyContent.create(
        CategoryId.of(cmd.categoryId()),
        new DaySequence(cmd.daySequence()),
        Keyword.of(cmd.keyword()),
        ContentDescription.of(cmd.title(), cmd.summary(), cmd.body()),
        ImageFile.of(cmd.imageUrl())
    );

    for (CreateNewsCommand n : cmd.newsList()) {
        dc.addNewsItem(
            n.title(),
            new NewsItemOrder(n.order()),
            WebLink.of(n.url()),
            ImageFile.of(n.imageUrl())
        );
    }

    for (CreateQuizCommand q : cmd.quizList()) {
        QuizOptions options = QuizOptions.ofTexts(q.options());
        AnswerIndex answerIndex = new AnswerIndex(q.answerIndex());

        dc.addQuiz(
            q.question(),
            new QuestionOrder(q.order()),
            options,
            answerIndex
        );
    }

    DailyContent saved = dailyContentRepository.save(dc);
    return saved.getId();
}

```

관심사의 분리는 이렇게 정리할 수 있다.

- 서비스 계층
    - 트랜잭션 관리
    - 유스케이스 오케스트레이션(“하루치 경험 + 뉴스 + 퀴즈를 한 번에 구성”)
- 애그리거트 루트(DailyContent)
    - 하루치 경험의 일관성, 불변식, 내부 엔티티 관리
- VO
    - 자기 값의 유효성 검증

- Part 2에서는 DailyContent.java 한 파일을 기준으로,

  “하루치 학습 경험” 애그리거트가 어떤 책임을 갖고 있는지 살펴봤다.

- `@Entity`/`@Table`/유니크 제약으로

  “카테고리별 N일차는 하나”라는 불변식을 DB까지 끌어내리고,

- CategoryId, DaySequence, ContentDescription, Keyword, ImageFile 같은 값 객체들로

  원시 타입 대신 “의미 있는 타입 + 자체 검증”을 사용했다.

- NewsItem/Quiz는 같은 애그리거트 안에 속한 엔티티로 두고,

  `cascade + orphanRemoval + 단방향 OneToMany` 로 DailyContent 생명주기에 종속시켰다.

- 생성/수정/추가/삭제는 전부 DailyContent의 도메인 메서드를 통해 이루어지며,

  서비스 계층은 “VO 변환 + 애그리거트 조합 + 트랜잭션”에만 집중한다.
